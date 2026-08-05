import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
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
  JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
} from "../../container-runtime-json-compatibility-runner/src/runner";
import {
  JSON_COMPATIBILITY_CALLER_ENTRYPOINT,
  JSON_COMPATIBILITY_CALLER_SERVICE_NAME,
  parseJsonCompatibilityCallerPhaseStatusRequestV1,
  runnerStatusRequest,
} from "./protocol";

export const JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-caller-invocation-receipt-v1" as const;
export const JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-caller-status-receipt-v1" as const;

const MAX_CALLER_REQUEST_BYTES = 512 * 1024;
const MAX_RUNNER_RECEIPT_BYTES = 1984 * 1024;
const MAX_CALLER_RECEIPT_BYTES = 2016 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 110_000;
const CLOCK_SKEW_MILLISECONDS = 5_000;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityRunnerServiceBinding {
  invokePhase(input: unknown): Promise<unknown>;
  getPhaseStatus(input: unknown): Promise<unknown>;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type JsonCompatibilityCallerEnv = Omit<
  WidenGeneratedStringBindings<JsonCompatibilityCallerGeneratedEnv>,
  "CF_VERSION_METADATA" | "JSON_COMPATIBILITY_RUNNER_SERVICE"
> & {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_RUNNER_SERVICE:
    JsonCompatibilityRunnerServiceBinding;
};

export interface JsonCompatibilityCallerRuntime {
  now(): number;
}

interface CallerIdentity {
  readonly serviceName: typeof JSON_COMPATIBILITY_CALLER_SERVICE_NAME;
  readonly entrypoint: typeof JSON_COMPATIBILITY_CALLER_ENTRYPOINT;
  readonly versionId: string;
  readonly gateName:
    | "JSON_COMPATIBILITY_CALLER_ENABLED"
    | "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED";
  readonly privateRpcOnly: true;
}

interface RunnerTarget {
  readonly serviceName: typeof JSON_COMPATIBILITY_RUNNER_SERVICE_NAME;
  readonly entrypoint: typeof JSON_COMPATIBILITY_RUNNER_ENTRYPOINT;
  readonly versionId: string;
  readonly configSha256: string;
}

interface CallerTransport {
  readonly kind: "service-binding-rpc";
  readonly publicUrlUsed: false;
  readonly cloudflareRestUsed: false;
  readonly runnerBinding: "JSON_COMPATIBILITY_RUNNER_SERVICE";
  readonly rpcMethod: "invokePhase" | "getPhaseStatus";
}

export interface JsonCompatibilityCallerInvocationReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT;
  readonly status: "caller_phase_invocation_completed";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly caller: CallerIdentity;
  readonly runner: RunnerTarget;
  readonly authorizedPhaseRequestSha256: string;
  readonly privateTransport: CallerTransport & { readonly rpcMethod: "invokePhase" };
  readonly runnerReceipt: Readonly<Record<string, unknown>>;
  readonly runnerReceiptSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly callerBodySha256: string;
  readonly receiptSha256: string;
}

export interface JsonCompatibilityCallerStatusReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT;
  readonly status: "caller_phase_status_observed";
  readonly phaseStatus: string;
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly caller: CallerIdentity;
  readonly runner: RunnerTarget;
  readonly callerStatusRequestSha256: string;
  readonly privateTransport: CallerTransport & { readonly rpcMethod: "getPhaseStatus" };
  readonly runnerStatusReceipt: Readonly<Record<string, unknown>>;
  readonly runnerStatusReceiptSha256: string;
  readonly recovery: {
    readonly mode: "read-only-status-recovery";
    readonly executionRetryPermitted: false;
    readonly runnerInvokePhaseCalled: false;
    readonly originalCallerReceiptReconstructed: false;
  };
  readonly startedAt: string;
  readonly completedAt: string;
  readonly callerBodySha256: string;
  readonly receiptSha256: string;
}

interface CallerConfiguration {
  readonly versionId: string;
  readonly runnerVersionId: string;
  readonly runnerConfigSha256: string;
}

interface RequestBinding {
  readonly requestSha256: string;
  readonly commandIdSha256: string;
  readonly operatorVersionId: string;
}

interface ValidatedRunnerStatusReceipt {
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly phaseStatus: string;
}

export class JsonCompatibilityCallerError extends Error {
  constructor(
    readonly code:
      | "caller_disabled"
      | "caller_status_disabled"
      | "caller_configuration_error"
      | "invalid_caller_request"
      | "caller_runner_binding_mismatch"
      | "runner_unavailable"
      | "invalid_runner_receipt"
      | "caller_receipt_too_large",
  ) {
    super(code);
    this.name = "JsonCompatibilityCallerError";
  }
}

export async function invokeJsonCompatibilityCallerPhase(
  env: JsonCompatibilityCallerEnv,
  input: unknown,
  runtime: JsonCompatibilityCallerRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityCallerInvocationReceiptV1> {
  const configuration = requireCallerEnvironment(env, "invoke");
  const startedAtMs = runtimeNow(runtime);
  assertBoundedJson(input, MAX_CALLER_REQUEST_BYTES, "invalid_caller_request");
  let authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  try {
    authorized = parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(input);
  } catch {
    throw callerError("invalid_caller_request");
  }
  const requestBinding = await validateCallerRequest(authorized, configuration);
  let rawRunnerReceipt: unknown;
  try {
    rawRunnerReceipt = await env.JSON_COMPATIBILITY_RUNNER_SERVICE
      .invokePhase(authorized);
  } catch {
    throw callerError("runner_unavailable");
  }
  const completedAtMs = runtimeNow(runtime);
  assertMonotonicClock(startedAtMs, completedAtMs);
  const runnerReceipt = await validateRunnerInvocationReceipt(
    rawRunnerReceipt,
    authorized,
    requestBinding,
    configuration,
    completedAtMs,
  );
  const common = await callerReceiptBody(
    authorized,
    configuration,
    "JSON_COMPATIBILITY_CALLER_ENABLED",
    "invokePhase",
    startedAtMs,
    completedAtMs,
  );
  const receiptBody = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
    status: "caller_phase_invocation_completed" as const,
    ...common,
    authorizedPhaseRequestSha256: await sha256Hex(canonicalJson(authorized)),
    runnerReceipt,
    runnerReceiptSha256: await sha256Hex(canonicalJson(runnerReceipt)),
  };
  return await sealCallerReceipt(receiptBody);
}

export async function getJsonCompatibilityCallerPhaseStatus(
  env: JsonCompatibilityCallerEnv,
  input: unknown,
  runtime: JsonCompatibilityCallerRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityCallerStatusReceiptV1> {
  const configuration = requireCallerEnvironment(env, "status");
  const startedAtMs = runtimeNow(runtime);
  assertBoundedJson(input, MAX_CALLER_REQUEST_BYTES, "invalid_caller_request");
  let authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  let callerStatusRequest: ReturnType<
    typeof parseJsonCompatibilityCallerPhaseStatusRequestV1
  >;
  try {
    callerStatusRequest = parseJsonCompatibilityCallerPhaseStatusRequestV1(
      input,
    );
    authorized = callerStatusRequest.authorizedPhaseRequest;
  } catch {
    throw callerError("invalid_caller_request");
  }
  const requestBinding = await validateCallerRequest(authorized, configuration);
  const runnerRequest = runnerStatusRequest(authorized);
  let rawRunnerReceipt: unknown;
  try {
    rawRunnerReceipt = await env.JSON_COMPATIBILITY_RUNNER_SERVICE
      .getPhaseStatus(runnerRequest);
  } catch {
    throw callerError("runner_unavailable");
  }
  const completedAtMs = runtimeNow(runtime);
  assertMonotonicClock(startedAtMs, completedAtMs);
  const validated = await validateRunnerStatusReceipt(
    rawRunnerReceipt,
    authorized,
    requestBinding,
    configuration,
    completedAtMs,
  );
  const common = await callerReceiptBody(
    authorized,
    configuration,
    "JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED",
    "getPhaseStatus",
    startedAtMs,
    completedAtMs,
  );
  const receiptBody = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
    status: "caller_phase_status_observed" as const,
    phaseStatus: validated.phaseStatus,
    ...common,
    callerStatusRequestSha256:
      await sha256Hex(canonicalJson(callerStatusRequest)),
    runnerStatusReceipt: validated.receipt,
    runnerStatusReceiptSha256:
      await sha256Hex(canonicalJson(validated.receipt)),
    recovery: {
      mode: "read-only-status-recovery" as const,
      executionRetryPermitted: false as const,
      runnerInvokePhaseCalled: false as const,
      originalCallerReceiptReconstructed: false as const,
    },
  };
  return await sealCallerReceipt(receiptBody);
}

async function validateCallerRequest(
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  configuration: CallerConfiguration,
): Promise<RequestBinding> {
  const request = authorized.request;
  const subject = authorized.approval.subject;
  const operatorVersionId = token(
    subject.operator.versionId,
    "caller_runner_binding_mismatch",
  );
  const requestSha256 = await sha256Hex(canonicalJson(request));
  const commandIdSha256 = await deriveJsonCompatibilityOperatorCommandId(
    request,
    operatorVersionId,
  );
  if (
    subject.caller.serviceName !== JSON_COMPATIBILITY_RUNNER_SERVICE_NAME
    || subject.caller.entrypoint !== JSON_COMPATIBILITY_RUNNER_ENTRYPOINT
    || subject.caller.versionId !== configuration.runnerVersionId
    || subject.caller.configSha256 !== configuration.runnerConfigSha256
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
    throw callerError("caller_runner_binding_mismatch");
  }
  return { requestSha256, commandIdSha256, operatorVersionId };
}

async function validateRunnerInvocationReceipt(
  input: unknown,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: RequestBinding,
  configuration: CallerConfiguration,
  callerCompletedAtMs: number,
): Promise<Readonly<Record<string, unknown>>> {
  const value = normalizedBoundedRecord(input, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "runner", "operator",
    "authorizedPhaseRequest", "authorizedPhaseRequestSha256",
    "privateTransport", "operatorReceipt", "operatorReceiptSha256",
    "startedAt", "completedAt", "runnerBodySha256", "receiptSha256",
  ]);
  const runnerCompletedAtMs = await validateRunnerReceiptEnvelope(
    value,
    authorized,
    binding,
    configuration,
    JSON_COMPATIBILITY_RUNNER_INVOCATION_RECEIPT_CONTRACT,
    "runner_phase_invocation_completed",
    "JSON_COMPATIBILITY_RUNNER_ENABLED",
    "invokePhase",
    callerCompletedAtMs,
  );
  const operatorReceipt = exactRecord(value.operatorReceipt, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "authorization", "request",
    "requestSha256", "commandIdSha256", "privateTransport",
    "privateInvocationReceipt", "privateInvocationReceiptSha256",
    "startedAt", "completedAt", "operatorBodySha256", "receiptSha256",
  ], "invalid_runner_receipt");
  if (
    digest(value.operatorReceiptSha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(operatorReceipt))
  ) {
    throw callerError("invalid_runner_receipt");
  }
  await validateOperatorInvocationReceipt(
    operatorReceipt,
    authorized,
    binding,
    runnerCompletedAtMs,
  );
  return value;
}

async function validateRunnerStatusReceipt(
  input: unknown,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: RequestBinding,
  configuration: CallerConfiguration,
  callerCompletedAtMs: number,
): Promise<ValidatedRunnerStatusReceipt> {
  const value = normalizedBoundedRecord(input, [
    "schemaVersion", "contract", "status", "phaseStatus", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "runner", "operator",
    "authorizedPhaseRequest", "authorizedPhaseRequestSha256",
    "privateTransport", "operatorStatusReceipt",
    "operatorStatusReceiptSha256", "recovery", "startedAt", "completedAt",
    "runnerBodySha256", "receiptSha256",
  ]);
  const runnerCompletedAtMs = await validateRunnerReceiptEnvelope(
    value,
    authorized,
    binding,
    configuration,
    JSON_COMPATIBILITY_RUNNER_STATUS_RECEIPT_CONTRACT,
    "runner_phase_status_observed",
    "JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED",
    "getPhaseStatus",
    callerCompletedAtMs,
  );
  const phaseStatus = observedPhaseStatus(value.phaseStatus);
  const operatorReceipt = exactRecord(value.operatorStatusReceipt, [
    "schemaVersion", "contract", "status", "phaseStatus", "environment",
    "campaignIdSha256", "planDigestSha256", "phaseExecutionId",
    "phaseOrdinal", "phaseId", "operator", "authorization", "request",
    "requestSha256", "commandIdSha256", "statusQuery", "statusQuerySha256",
    "privateTransport", "privateInvocationStatusReceipt",
    "privateInvocationStatusReceiptSha256", "recovery", "queryStartedAt",
    "queryCompletedAt", "operatorBodySha256", "receiptSha256",
  ], "invalid_runner_receipt");
  if (
    digest(value.operatorStatusReceiptSha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(operatorReceipt))
  ) {
    throw callerError("invalid_runner_receipt");
  }
  const operatorPhaseStatus = await validateOperatorStatusReceipt(
    operatorReceipt,
    authorized,
    binding,
    runnerCompletedAtMs,
  );
  const recovery = exactRecord(value.recovery, [
    "mode", "executionRetryPermitted", "operatorInvokePhaseCalled",
    "originalRunnerReceiptReconstructed",
  ], "invalid_runner_receipt");
  if (
    operatorPhaseStatus !== phaseStatus
    || recovery.mode !== "read-only-status-recovery"
    || recovery.executionRetryPermitted !== false
    || recovery.operatorInvokePhaseCalled !== false
    || recovery.originalRunnerReceiptReconstructed !== false
  ) {
    throw callerError("invalid_runner_receipt");
  }
  return { receipt: value, phaseStatus };
}

async function validateRunnerReceiptEnvelope(
  value: Record<string, unknown>,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: RequestBinding,
  configuration: CallerConfiguration,
  expectedContract: string,
  expectedStatus: string,
  expectedGate: string,
  expectedMethod: CallerTransport["rpcMethod"],
  callerCompletedAtMs: number,
): Promise<number> {
  const request = authorized.request;
  const runner = exactRecord(value.runner, [
    "serviceName", "entrypoint", "versionId", "configSha256", "gateName",
    "privateRpcOnly",
  ], "invalid_runner_receipt");
  const operator = exactRecord(value.operator, [
    "serviceName", "entrypoint", "versionId",
  ], "invalid_runner_receipt");
  const transport = exactRecord(value.privateTransport, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "operatorBinding",
    "rpcMethod",
  ], "invalid_runner_receipt");
  let embeddedAuthorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  try {
    embeddedAuthorized = parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(
      value.authorizedPhaseRequest,
    );
  } catch {
    throw callerError("invalid_runner_receipt");
  }
  const startedAt = timestamp(value.startedAt);
  const completedAt = timestamp(value.completedAt);
  const runnerStartedAtMs = Date.parse(startedAt);
  const runnerCompletedAtMs = Date.parse(completedAt);
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
    || runner.serviceName !== JSON_COMPATIBILITY_RUNNER_SERVICE_NAME
    || runner.entrypoint !== JSON_COMPATIBILITY_RUNNER_ENTRYPOINT
    || runner.versionId !== configuration.runnerVersionId
    || runner.configSha256 !== configuration.runnerConfigSha256
    || runner.gateName !== expectedGate
    || runner.privateRpcOnly !== true
    || operator.serviceName !== JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME
    || operator.entrypoint !== "JsonCompatibilityCampaignOperatorEntrypoint"
    || operator.versionId !== binding.operatorVersionId
    || canonicalJson(embeddedAuthorized) !== canonicalJson(authorized)
    || digest(value.authorizedPhaseRequestSha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(authorized))
    || transport.kind !== "service-binding-rpc"
    || transport.publicUrlUsed !== false
    || transport.cloudflareRestUsed !== false
    || transport.operatorBinding !== "JSON_COMPATIBILITY_OPERATOR_SERVICE"
    || transport.rpcMethod !== expectedMethod
    || runnerCompletedAtMs < runnerStartedAtMs
    || runnerCompletedAtMs > callerCompletedAtMs + CLOCK_SKEW_MILLISECONDS
  ) {
    throw callerError("invalid_runner_receipt");
  }
  const { runnerBodySha256, receiptSha256, ...body } = value;
  if (
    digest(runnerBodySha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(body))
    || digest(receiptSha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson({ ...body, runnerBodySha256 }))
  ) {
    throw callerError("invalid_runner_receipt");
  }
  return runnerCompletedAtMs;
}

async function validateOperatorInvocationReceipt(
  value: Record<string, unknown>,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: RequestBinding,
  runnerCompletedAtMs: number,
): Promise<void> {
  await validateOperatorReceiptEnvelope(
    value,
    authorized,
    binding,
    JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
    "operator_phase_invocation_completed",
    JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    "JSON_COMPATIBILITY_OPERATOR_ENABLED",
    "invokePhase",
    runnerCompletedAtMs,
  );
  const privateReceipt = record(
    value.privateInvocationReceipt,
    "invalid_runner_receipt",
  );
  if (
    digest(value.privateInvocationReceiptSha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(privateReceipt))
  ) {
    throw callerError("invalid_runner_receipt");
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
    throw callerError("invalid_runner_receipt");
  }
}

async function validateOperatorStatusReceipt(
  value: Record<string, unknown>,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: RequestBinding,
  runnerCompletedAtMs: number,
): Promise<string> {
  await validateOperatorReceiptEnvelope(
    value,
    authorized,
    binding,
    JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_RECEIPT_CONTRACT,
    "operator_phase_status_observed",
    JSON_COMPATIBILITY_OPERATOR_PHASE_STATUS_REQUEST_CONTRACT,
    "JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED",
    "getPhaseStatus",
    runnerCompletedAtMs,
    "queryStartedAt",
    "queryCompletedAt",
  );
  const phaseStatus = observedPhaseStatus(value.phaseStatus);
  const statusQuery = record(value.statusQuery, "invalid_runner_receipt");
  const querySubject = record(statusQuery.subject, "invalid_runner_receipt");
  const target = record(querySubject.target, "invalid_runner_receipt");
  const approvalEnvelopeSha256 = await sha256Hex(
    canonicalJson(authorized.approval),
  );
  if (
    digest(value.statusQuerySha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(statusQuery))
    || target.operatorRequestSha256 !== binding.requestSha256
    || target.approvalEnvelopeSha256 !== approvalEnvelopeSha256
    || target.operatorVersionId !== binding.operatorVersionId
    || target.commandIdSha256 !== binding.commandIdSha256
  ) {
    throw callerError("invalid_runner_receipt");
  }
  const privateStatus = record(
    value.privateInvocationStatusReceipt,
    "invalid_runner_receipt",
  );
  if (
    digest(
      value.privateInvocationStatusReceiptSha256,
      "invalid_runner_receipt",
    ) !== await sha256Hex(canonicalJson(privateStatus))
  ) {
    throw callerError("invalid_runner_receipt");
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
        runnerCompletedAtMs,
      );
  } catch {
    throw callerError("invalid_runner_receipt");
  }
  const recovery = exactRecord(value.recovery, [
    "mode", "executionRetryPermitted", "invokePhaseCalled",
    "permitIssuerCalled", "executorCalled",
    "originalOperatorReceiptReconstructed",
  ], "invalid_runner_receipt");
  if (
    validatedPrivateStatus.phaseStatus !== phaseStatus
    || recovery.mode !== "read-only-status-recovery"
    || recovery.executionRetryPermitted !== false
    || recovery.invokePhaseCalled !== false
    || recovery.permitIssuerCalled !== false
    || recovery.executorCalled !== false
    || recovery.originalOperatorReceiptReconstructed !== false
  ) {
    throw callerError("invalid_runner_receipt");
  }
  return phaseStatus;
}

async function validateOperatorReceiptEnvelope(
  value: Record<string, unknown>,
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  binding: RequestBinding,
  expectedContract: string,
  expectedStatus: string,
  expectedAuthorizationContract: string,
  expectedGate: string,
  expectedMethod: "invokePhase" | "getPhaseStatus",
  runnerCompletedAtMs: number,
  startedAtField = "startedAt",
  completedAtField = "completedAt",
): Promise<void> {
  const request = authorized.request;
  const approval = authorized.approval;
  const subject = approval.subject;
  const operator = exactRecord(value.operator, [
    "serviceName", "versionId", "gateName",
  ], "invalid_runner_receipt");
  const authorization = exactRecord(value.authorization, [
    "contract", "approvalEnvelope", "approvalEnvelopeSha256",
    "approvalSubjectSha256", "issuer", "audience", "keyId",
    "signerSpkiSha256", "caller", "issuedAt", "notBefore", "expiresAt",
  ], "invalid_runner_receipt");
  const transportKeys = expectedMethod === "invokePhase"
    ? ["kind", "publicUrlUsed", "cloudflareRestUsed", "invokerBinding"]
    : [
        "kind", "publicUrlUsed", "cloudflareRestUsed", "invokerBinding",
        "rpcMethod",
      ];
  const transport = exactRecord(
    value.privateTransport,
    transportKeys,
    "invalid_runner_receipt",
  );
  const startedAt = timestamp(value[startedAtField]);
  const completedAt = timestamp(value[completedAtField]);
  const expectedSpkiSha256 = await sha256Hex(
    decodeBase64url(approval.signerSpkiBase64url),
  );
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
    || operator.versionId !== binding.operatorVersionId
    || operator.gateName !== expectedGate
    || authorization.contract !== expectedAuthorizationContract
    || canonicalJson(authorization.approvalEnvelope)
      !== canonicalJson(approval)
    || authorization.approvalEnvelopeSha256
      !== await sha256Hex(canonicalJson(approval))
    || authorization.approvalSubjectSha256
      !== await sha256Hex(canonicalJson(subject))
    || authorization.issuer !== subject.issuer
    || authorization.audience !== subject.audience
    || authorization.keyId !== subject.keyId
    || authorization.signerSpkiSha256 !== expectedSpkiSha256
    || canonicalJson(authorization.caller) !== canonicalJson(subject.caller)
    || authorization.issuedAt !== subject.issuedAt
    || authorization.notBefore !== subject.notBefore
    || authorization.expiresAt !== subject.expiresAt
    || canonicalJson(value.request) !== canonicalJson(request)
    || value.requestSha256 !== binding.requestSha256
    || value.commandIdSha256 !== binding.commandIdSha256
    || transport.kind !== "service-binding-rpc"
    || transport.publicUrlUsed !== false
    || transport.cloudflareRestUsed !== false
    || transport.invokerBinding !== "JSON_COMPATIBILITY_INVOKER_SERVICE"
    || (expectedMethod === "getPhaseStatus"
      && transport.rpcMethod !== "getPhaseStatus")
    || Date.parse(completedAt) < Date.parse(startedAt)
    || Date.parse(completedAt)
      > runnerCompletedAtMs + CLOCK_SKEW_MILLISECONDS
  ) {
    throw callerError("invalid_runner_receipt");
  }
  const { operatorBodySha256, receiptSha256, ...body } = value;
  if (
    digest(operatorBodySha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson(body))
    || digest(receiptSha256, "invalid_runner_receipt")
      !== await sha256Hex(canonicalJson({ ...body, operatorBodySha256 }))
  ) {
    throw callerError("invalid_runner_receipt");
  }
}

async function callerReceiptBody<
  const Method extends CallerTransport["rpcMethod"],
>(
  authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  configuration: CallerConfiguration,
  gateName: CallerIdentity["gateName"],
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
    caller: {
      serviceName: JSON_COMPATIBILITY_CALLER_SERVICE_NAME,
      entrypoint: JSON_COMPATIBILITY_CALLER_ENTRYPOINT,
      versionId: configuration.versionId,
      gateName,
      privateRpcOnly: true as const,
    },
    runner: {
      serviceName: JSON_COMPATIBILITY_RUNNER_SERVICE_NAME,
      entrypoint: JSON_COMPATIBILITY_RUNNER_ENTRYPOINT,
      versionId: configuration.runnerVersionId,
      configSha256: configuration.runnerConfigSha256,
    },
    privateTransport: {
      kind: "service-binding-rpc" as const,
      publicUrlUsed: false as const,
      cloudflareRestUsed: false as const,
      runnerBinding: "JSON_COMPATIBILITY_RUNNER_SERVICE" as const,
      rpcMethod,
    },
    startedAt: wholeSecondUtc(startedAtMs),
    completedAt: wholeSecondUtc(completedAtMs),
  };
}

async function sealCallerReceipt<Body extends Record<string, unknown>>(
  body: Body,
): Promise<Body & { readonly callerBodySha256: string; readonly receiptSha256: string }> {
  const callerBodySha256 = await sha256Hex(canonicalJson(body));
  const subject = { ...body, callerBodySha256 };
  const receipt = {
    ...subject,
    receiptSha256: await sha256Hex(canonicalJson(subject)),
  };
  assertBoundedJson(
    receipt,
    MAX_CALLER_RECEIPT_BYTES,
    "caller_receipt_too_large",
  );
  return receipt;
}

function requireCallerEnvironment(
  env: JsonCompatibilityCallerEnv,
  purpose: "invoke" | "status",
): CallerConfiguration {
  if (env.ENVIRONMENT !== "staging") {
    throw callerError("caller_configuration_error");
  }
  if (
    purpose === "invoke"
      ? env.JSON_COMPATIBILITY_CALLER_ENABLED !== "true"
      : env.JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED !== "true"
  ) {
    throw callerError(
      purpose === "invoke" ? "caller_disabled" : "caller_status_disabled",
    );
  }
  const versionId = token(
    env.CF_VERSION_METADATA?.id,
    "caller_configuration_error",
  );
  const runnerVersionId = token(
    env.JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID,
    "caller_configuration_error",
  );
  const runnerConfigSha256 = digest(
    env.JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256,
    "caller_configuration_error",
  );
  const method = purpose === "invoke" ? "invokePhase" : "getPhaseStatus";
  if (
    env.JSON_COMPATIBILITY_RUNNER_SERVICE === null
    || typeof env.JSON_COMPATIBILITY_RUNNER_SERVICE !== "object"
    || typeof env.JSON_COMPATIBILITY_RUNNER_SERVICE[method] !== "function"
  ) {
    throw callerError("caller_configuration_error");
  }
  return { versionId, runnerVersionId, runnerConfigSha256 };
}

function normalizedBoundedRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const normalized = normalizeRpcJson(input, "invalid_runner_receipt");
  assertBoundedJson(
    normalized,
    MAX_RUNNER_RECEIPT_BYTES,
    "invalid_runner_receipt",
  );
  return exactRecord(normalized, expectedKeys, "invalid_runner_receipt");
}

async function validateClaimedReceiptDigest(
  value: Record<string, unknown>,
): Promise<void> {
  const claimed = digest(value.receiptSha256, "invalid_runner_receipt");
  const { receiptSha256: _receiptSha256, ...subject } = value;
  if (claimed !== await sha256Hex(canonicalJson(subject))) {
    throw callerError("invalid_runner_receipt");
  }
}

function observedPhaseStatus(value: unknown): string {
  const status = token(value, "invalid_runner_receipt");
  if (!new Set([
    "not_found",
    "active",
    "failed",
    "completed",
    "completed_receipt_unavailable",
  ]).has(status)) {
    throw callerError("invalid_runner_receipt");
  }
  return status;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  code: JsonCompatibilityCallerError["code"],
): Record<string, unknown> {
  const value = record(input, code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw callerError(code);
  }
  return value;
}

function record(
  input: unknown,
  code: JsonCompatibilityCallerError["code"],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw callerError(code);
  }
  return input as Record<string, unknown>;
}

function token(
  value: unknown,
  code: JsonCompatibilityCallerError["code"],
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw callerError(code);
  }
  return value;
}

function digest(
  value: unknown,
  code: JsonCompatibilityCallerError["code"],
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw callerError(code);
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
    throw callerError("invalid_runner_receipt");
  }
  return value;
}

function runtimeNow(runtime: JsonCompatibilityCallerRuntime): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw callerError("caller_configuration_error");
  }
  return value;
}

function assertMonotonicClock(startedAtMs: number, completedAtMs: number): void {
  if (completedAtMs < startedAtMs) {
    throw callerError("caller_configuration_error");
  }
}

function wholeSecondUtc(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw callerError("invalid_runner_receipt");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  } catch {
    throw callerError("invalid_runner_receipt");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function assertBoundedJson(
  input: unknown,
  maximumBytes: number,
  code: JsonCompatibilityCallerError["code"],
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
    if (bytes > maximumBytes) throw callerError(code);
  };
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) throw callerError(code);
    if (current.exit) {
      if (typeof current.value === "object" && current.value !== null) {
        ancestors.delete(current.value);
      }
      continue;
    }
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw callerError(code);
    }
    const value = current.value;
    if (value === null) add(4);
    else if (typeof value === "string") {
      add(encoder.encode(JSON.stringify(value)).byteLength);
    } else if (typeof value === "boolean") add(value ? 4 : 5);
    else if (typeof value === "number" && Number.isFinite(value)) {
      add(String(value).length);
    } else if (typeof value === "object") {
      if (ancestors.has(value)) throw callerError(code);
      if (Object.getOwnPropertySymbols(value).some((symbol) =>
        Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true
      )) {
        throw callerError(code);
      }
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
    } else throw callerError(code);
  }
}

function normalizeRpcJson(
  input: unknown,
  code: JsonCompatibilityCallerError["code"],
): unknown {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw callerError(code);
    }
    if (
      value === null
      || typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) return value;
    if (typeof value !== "object" || ancestors.has(value)) {
      throw callerError(code);
    }
    if (Object.getOwnPropertySymbols(value).some((symbol) =>
      Object.getOwnPropertyDescriptor(value, symbol)?.enumerable === true
    )) {
      throw callerError(code);
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
        if (!("value" in descriptor)) throw callerError(code);
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

function callerError(
  code: JsonCompatibilityCallerError["code"],
): JsonCompatibilityCallerError {
  return new JsonCompatibilityCallerError(code);
}
