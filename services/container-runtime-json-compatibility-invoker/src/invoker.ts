import {
  canonicalJson,
  sha256Hex,
  verifyJsonCompatibilityProbeResultDigests,
} from "../../container-controller/src/json_compatibility_probe";
import {
  verifyJsonCompatibilityPhasePermit,
} from "../../container-runtime-json-compatibility-executor/src/authorization";
import {
  JSON_COMPATIBILITY_CONTROLLER_ENTRYPOINT,
  JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
  JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
  JSON_COMPATIBILITY_MAX_CONCURRENCY,
  JSON_COMPATIBILITY_PHASE_IDS,
  JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_SHARD_COUNT,
  expectedRuntimeGeneration,
  jsonCompatibilityShardInstanceName,
  parseJsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityExecutePhaseRequestV2,
  type JsonCompatibilityPhaseId,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import type {
  JsonCompatibilityPhaseProbeObservationV1,
  JsonCompatibilityPhaseProbeReceiptV2,
} from "../../container-runtime-json-compatibility-executor/src/executor";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
  JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
  createPermitIssueAuthorityEnvelope,
  deriveJsonCompatibilityPermitIdSha256,
  jsonCompatibilityIssuerCampaignBinding,
  parseJsonCompatibilityPermitIssueIntentV1,
  type JsonCompatibilityPermitIssueReceiptV1,
  type JsonCompatibilityPermitIssueRequestV1,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";
import {
  JSON_COMPATIBILITY_PERMIT_ISSUANCE_RECEIPT_CONTRACT,
  type JsonCompatibilityPermitIssuanceReceiptV1,
} from "../../container-runtime-json-compatibility-permit-issuer/src/issuance_authority";
import {
  type JsonCompatibilityInvocationStatusQueryV1,
  type JsonCompatibilityInvocationStatusTargetV1,
  type JsonCompatibilityInvokeCommandV1,
  type VerifiedJsonCompatibilityInvocationStatusAuthorityV1,
  type VerifiedJsonCompatibilityInvokeAuthorityV1,
  parseJsonCompatibilityInvokeCommandV1,
  verifyJsonCompatibilityInvocationStatusQuery,
  verifyJsonCompatibilityInvokeCommand,
} from "./authorization";
import {
  JSON_COMPATIBILITY_INVOCATION_ATTEMPT_STATUS_QUERY_CONTRACT,
  JSON_COMPATIBILITY_INVOCATION_COMPLETION_RECEIPT_CONTRACT,
  JsonCompatibilityInvocationAuthority,
  type JsonCompatibilityInvocationAttemptReceiptV1,
  type JsonCompatibilityInvocationAttemptStatusResult,
  type JsonCompatibilityInvocationCompletionReceiptV1,
  type JsonCompatibilityInvocationAuthorityErrorCode,
} from "./invocation_authority";

export const JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1" as const;
export const JSON_COMPATIBILITY_PRIVATE_INVOCATION_STATUS_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-private-invocation-status-receipt-v1" as const;

const ATTEMPT_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-id-v1\n";
const ISSUER_REQUEST_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-issuer-request-id-v1\n";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_INVOCATION_RECEIPT_BYTES = 1536 * 1024;

export interface JsonCompatibilityPermitIssuerBinding {
  issuePhasePermit(input: unknown): Promise<unknown>;
}

export interface JsonCompatibilityExecutorBinding {
  executePhase(input: unknown): Promise<unknown>;
}

interface InvokerSecrets {
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET?: string;
  readonly JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_SECRET?: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_CURRENT_SECRET?: string;
  readonly JSON_COMPATIBILITY_INVOKER_STATUS_OPERATOR_PREVIOUS_SECRET?: string;
  readonly JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET?: string;
  readonly JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL?: string;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type JsonCompatibilityInvokerEnv = Omit<
  WidenGeneratedStringBindings<JsonCompatibilityInvokerGeneratedEnv>,
  | "CF_VERSION_METADATA"
  | "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE"
  | "JSON_COMPATIBILITY_EXECUTOR_SERVICE"
  | "JSON_COMPATIBILITY_INVOCATION_AUTHORITY"
> & {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE:
    JsonCompatibilityPermitIssuerBinding;
  readonly JSON_COMPATIBILITY_EXECUTOR_SERVICE: JsonCompatibilityExecutorBinding;
  readonly JSON_COMPATIBILITY_INVOCATION_AUTHORITY:
    DurableObjectNamespace<JsonCompatibilityInvocationAuthority>;
} & InvokerSecrets;

export interface JsonCompatibilityInvokerRuntime {
  now(): number;
}

export interface JsonCompatibilityPrivateInvocationReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract: typeof JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_CONTRACT;
  readonly status: "private_phase_invocation_completed";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly command: JsonCompatibilityInvokeCommandV1;
  readonly commandAuthority: VerifiedJsonCompatibilityInvokeAuthorityV1;
  readonly invoker: {
    readonly serviceName: typeof JSON_COMPATIBILITY_INVOKER_SERVICE_NAME;
    readonly versionId: string;
    readonly gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED";
  };
  readonly privateTransport: {
    readonly kind: "service-binding-rpc";
    readonly publicUrlUsed: false;
    readonly cloudflareRestUsed: false;
    readonly permitIssuerBinding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE";
    readonly executorBinding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE";
  };
  readonly invocationAuthority: {
    readonly attempt: JsonCompatibilityInvocationAttemptReceiptV1;
    readonly completion: JsonCompatibilityInvocationCompletionReceiptV1;
  };
  readonly permitIssueReceipt: JsonCompatibilityPermitIssueReceiptV1;
  readonly executorReceipt: JsonCompatibilityPhaseProbeReceiptV2;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly invocationBodySha256: string;
  readonly receiptSha256: string;
}

export type JsonCompatibilityPrivateInvocationStatusResultV1 =
  | { readonly status: "not_found"; readonly retryPermitted: false }
  | {
      readonly status: "active";
      readonly attempt: JsonCompatibilityInvocationAttemptReceiptV1;
      readonly retryPermitted: false;
    }
  | {
      readonly status: "failed";
      readonly attempt: JsonCompatibilityInvocationAttemptReceiptV1;
      readonly failureCode: string;
      readonly failedAt: number;
      readonly retryPermitted: false;
    }
  | {
      readonly status: "completed_receipt_unavailable";
      readonly attempt: JsonCompatibilityInvocationAttemptReceiptV1;
      readonly completion: JsonCompatibilityInvocationCompletionReceiptV1;
      readonly retryPermitted: false;
      readonly executionRpcRepeated: false;
    }
  | {
      readonly status: "completed";
      readonly attempt: JsonCompatibilityInvocationAttemptReceiptV1;
      readonly completion: JsonCompatibilityInvocationCompletionReceiptV1;
      readonly privateInvocationReceipt: Readonly<Record<string, unknown>>;
      readonly privateInvocationReceiptSha256: string;
      readonly recoveredFromPersistedAuthority: true;
      readonly retryPermitted: false;
      readonly executionRpcRepeated: false;
    };

export interface JsonCompatibilityPrivateInvocationStatusReceiptV1 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_PRIVATE_INVOCATION_STATUS_RECEIPT_CONTRACT;
  readonly status: "private_invocation_status_resolved";
  readonly environment: "staging";
  readonly target: JsonCompatibilityInvocationStatusTargetV1;
  readonly query: JsonCompatibilityInvocationStatusQueryV1;
  readonly queryAuthority:
    VerifiedJsonCompatibilityInvocationStatusAuthorityV1;
  readonly invoker: {
    readonly serviceName: typeof JSON_COMPATIBILITY_INVOKER_SERVICE_NAME;
    readonly versionId: string;
    readonly gateName: "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED";
  };
  readonly privateTransport: {
    readonly kind: "service-binding-rpc";
    readonly publicUrlUsed: false;
    readonly cloudflareRestUsed: false;
    readonly invocationAuthorityBinding:
      "JSON_COMPATIBILITY_INVOCATION_AUTHORITY";
  };
  readonly result: JsonCompatibilityPrivateInvocationStatusResultV1;
  readonly queriedAt: string;
  readonly receiptSha256: string;
}

export class JsonCompatibilityInvokerError extends Error {
  constructor(
    readonly code:
      | "invoker_disabled"
      | "invocation_status_disabled"
      | "invoker_configuration_error"
      | "invocation_authority_conflict"
      | "invocation_authority_unavailable"
      | "permit_issuer_rejected"
      | "permit_issuer_unavailable"
      | "invalid_permit_issue_receipt"
      | "executor_rejected"
      | "executor_unavailable"
      | "invalid_executor_receipt"
      | "invalid_invocation_status"
      | "invocation_status_authority_unavailable",
  ) {
    super(code);
    this.name = "JsonCompatibilityInvokerError";
  }
}

export async function getJsonCompatibilityPhaseStatus(
  env: JsonCompatibilityInvokerEnv,
  input: unknown,
  runtime: JsonCompatibilityInvokerRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityPrivateInvocationStatusReceiptV1> {
  requireInvokerStatusEnvironment(env);
  const queriedAtMs = runtimeNow(runtime, "status query time");
  const invokerVersionId = token(
    env.CF_VERSION_METADATA?.id,
    "invoker_configuration_error",
  );
  const verified = await verifyJsonCompatibilityInvocationStatusQuery(
    env,
    input,
    invokerVersionId,
    queriedAtMs,
  );
  const target = verified.query.subject.target;
  const authority = env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY.getByName(
    target.campaignIdSha256,
  );
  let authorityResult: JsonCompatibilityInvocationAttemptStatusResult;
  try {
    authorityResult = await authority.getAttemptStatus({
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_INVOCATION_ATTEMPT_STATUS_QUERY_CONTRACT,
      campaignIdSha256: target.campaignIdSha256,
      planDigestSha256: target.planDigestSha256,
      phaseOrdinal: target.phaseOrdinal,
      phaseId: target.phaseId,
      phaseExecutionId: target.phaseExecutionId,
      commandIdSha256: target.commandIdSha256,
      invokerVersionId: target.invokerVersionId,
    });
  } catch {
    throw invokerError("invocation_status_authority_unavailable");
  }
  if (!authorityResult.ok) {
    throw invokerError("invalid_invocation_status");
  }
  const result = await statusResultFromAuthority(authorityResult, target);
  const receiptSubject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PRIVATE_INVOCATION_STATUS_RECEIPT_CONTRACT,
    status: "private_invocation_status_resolved" as const,
    environment: "staging" as const,
    target,
    query: verified.query,
    queryAuthority: verified.authority,
    invoker: {
      serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      versionId: invokerVersionId,
      gateName: "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED" as const,
    },
    privateTransport: {
      kind: "service-binding-rpc" as const,
      publicUrlUsed: false as const,
      cloudflareRestUsed: false as const,
      invocationAuthorityBinding:
        "JSON_COMPATIBILITY_INVOCATION_AUTHORITY" as const,
    },
    result,
    queriedAt: wholeSecondUtc(queriedAtMs),
  };
  const canonicalSubject = canonicalJson(receiptSubject);
  if (
    new TextEncoder().encode(canonicalSubject).byteLength
      > MAX_INVOCATION_RECEIPT_BYTES
  ) {
    throw invokerError("invalid_invocation_status");
  }
  return {
    ...receiptSubject,
    receiptSha256: await sha256Hex(canonicalSubject),
  };
}

export async function invokeJsonCompatibilityPhase(
  env: JsonCompatibilityInvokerEnv,
  input: unknown,
  runtime: JsonCompatibilityInvokerRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityPrivateInvocationReceiptV1> {
  requireInvokerEnvironment(env);
  const startedAtMs = runtimeNow(runtime, "invocation start time");
  const invokerVersionId = token(
    env.CF_VERSION_METADATA?.id,
    "invoker_configuration_error",
  );
  const verified = await verifyJsonCompatibilityInvokeCommand(
    env,
    input,
    invokerVersionId,
    startedAtMs,
  );
  const { command, authority } = verified;
  const intent = command.subject.issueIntent;
  const execution = intent.execution;
  const issueIntentSha256 = await sha256Hex(canonicalJson(intent));
  const campaignBindingSha256 = await jsonCompatibilityIssuerCampaignBinding(intent);
  const attemptIdSha256 = await sha256Hex(
    `${ATTEMPT_ID_DOMAIN}${command.subject.commandIdSha256}\n${issueIntentSha256}\n${invokerVersionId}`,
  );
  const attempt = await beginInvocationAttempt(
    env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY.getByName(
      execution.campaignIdSha256,
    ),
    command,
    authority,
    issueIntentSha256,
    campaignBindingSha256,
    attemptIdSha256,
    invokerVersionId,
    Math.floor(startedAtMs / 1000),
  );
  let completionRpcAttempted = false;

  try {
    const permitIssueRequest = await createPermitIssueRequest(
      env,
      command,
      issueIntentSha256,
      invokerVersionId,
      Math.floor(startedAtMs / 1000),
    );
    let rawPermitIssueReceipt: unknown;
    try {
      rawPermitIssueReceipt = await env.JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE
        .issuePhasePermit(permitIssueRequest);
    } catch (error) {
      if (hasRemoteCode(error)) throw invokerError("permit_issuer_rejected");
      throw invokerError("permit_issuer_unavailable");
    }
    const permitIssueReceipt = await validatePermitIssueReceipt(
      env,
      rawPermitIssueReceipt,
      intent,
      issueIntentSha256,
      permitIssueRequest,
      startedAtMs,
    );
    const executeRequest: JsonCompatibilityExecutePhaseRequestV2 = {
      ...execution,
      authorization: permitIssueReceipt.permitEnvelope,
    };
    let rawExecutorReceipt: unknown;
    try {
      rawExecutorReceipt = await env.JSON_COMPATIBILITY_EXECUTOR_SERVICE
        .executePhase(executeRequest);
    } catch (error) {
      if (hasRemoteCode(error)) throw invokerError("executor_rejected");
      throw invokerError("executor_unavailable");
    }
    const executorReceipt = await validateExecutorReceipt(
      rawExecutorReceipt,
      executeRequest,
      intent.executor.versionId,
    );
    const completedAtMs = runtimeNow(runtime, "invocation completion time");
    if (completedAtMs < startedAtMs) {
      throw invokerError("invoker_configuration_error");
    }
    const receiptBody = {
      schemaVersion: 1 as const,
      contract: JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_CONTRACT,
      status: "private_phase_invocation_completed" as const,
      environment: "staging" as const,
      campaignIdSha256: execution.campaignIdSha256,
      planDigestSha256: execution.planDigestSha256,
      phaseExecutionId: execution.phaseExecutionId,
      phaseOrdinal: execution.phase.ordinal,
      phaseId: execution.phase.id,
      command,
      commandAuthority: authority,
      invoker: {
        serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
        versionId: invokerVersionId,
        gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED" as const,
      },
      privateTransport: {
        kind: "service-binding-rpc" as const,
        publicUrlUsed: false as const,
        cloudflareRestUsed: false as const,
        permitIssuerBinding:
          "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE" as const,
        executorBinding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE" as const,
      },
      invocationAuthority: { attempt },
      permitIssueReceipt,
      executorReceipt,
      startedAt: wholeSecondUtc(startedAtMs),
      completedAt: wholeSecondUtc(completedAtMs),
    };
    const canonicalReceiptBody = canonicalJson(receiptBody);
    if (
      new TextEncoder().encode(canonicalReceiptBody).byteLength
      > MAX_INVOCATION_RECEIPT_BYTES - 16 * 1024
    ) {
      throw invokerError("invalid_executor_receipt");
    }
    const invocationBodySha256 = await sha256Hex(canonicalReceiptBody);
    let completion;
    try {
      completionRpcAttempted = true;
      completion = await env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY
        .getByName(execution.campaignIdSha256)
        .completeAttemptV2({
          schemaVersion: 2,
          contract:
            "cinatoken-container-runtime-json-compatibility-invocation-attempt-complete-v2",
          campaignIdSha256: execution.campaignIdSha256,
          phaseOrdinal: execution.phase.ordinal,
          phaseExecutionId: execution.phaseExecutionId,
          commandIdSha256: command.subject.commandIdSha256,
          attemptIdSha256,
          permitIdSha256:
            permitIssueReceipt.permitEnvelope.subject.permitIdSha256,
          permitIssueReceiptSha256: permitIssueReceipt.receiptSha256,
          executorReceiptSha256: executorReceipt.receiptSha256,
          invocationBodySha256,
          invocationBodyJson: canonicalReceiptBody,
          completedAt: Math.floor(completedAtMs / 1000),
        });
    } catch {
      throw invokerError("invocation_authority_unavailable");
    }
    if (!completion.ok) throw authorityConflict(completion.error.code);
    const expectedStatus = execution.phase.ordinal === 4
      ? "invocation_campaign_completed"
      : "invocation_phase_completed";
    if (completion.status !== expectedStatus || completion.receipt === undefined) {
      throw invokerError("invocation_authority_unavailable");
    }
    await validateCompletionReceipt(
      completion.receipt,
      {
        campaignIdSha256: execution.campaignIdSha256,
        phaseOrdinal: execution.phase.ordinal,
        phaseExecutionId: execution.phaseExecutionId,
        commandIdSha256: command.subject.commandIdSha256,
        attemptIdSha256,
        permitIdSha256: permitIssueReceipt.permitEnvelope.subject.permitIdSha256,
        permitIssueReceiptSha256: permitIssueReceipt.receiptSha256,
        executorReceiptSha256: executorReceipt.receiptSha256,
        invocationBodySha256,
        completedAt: Math.floor(completedAtMs / 1000),
        status: expectedStatus,
      },
    );
    const receiptSubject = {
      ...receiptBody,
      invocationAuthority: {
        attempt,
        completion: completion.receipt,
      },
      invocationBodySha256,
    };
    const canonicalReceiptSubject = canonicalJson(receiptSubject);
    if (
      new TextEncoder().encode(canonicalReceiptSubject).byteLength
      > MAX_INVOCATION_RECEIPT_BYTES
    ) {
      throw invokerError("invocation_authority_unavailable");
    }
    const receipt = {
      ...receiptSubject,
      receiptSha256: await sha256Hex(canonicalReceiptSubject),
    };
    return receipt;
  } catch (error) {
    if (completionRpcAttempted) throw error;
    let failedAtMs = startedAtMs;
    try {
      failedAtMs = runtimeNow(runtime, "invocation failure time");
    } catch {
      // The persisted attempt remains terminal even if the injected clock fails.
    }
    let failure;
    try {
      failure = await env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY
        .getByName(execution.campaignIdSha256)
        .failAttempt({
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-invocation-attempt-fail-v1",
        campaignIdSha256: execution.campaignIdSha256,
        phaseOrdinal: execution.phase.ordinal,
        phaseExecutionId: execution.phaseExecutionId,
        commandIdSha256: command.subject.commandIdSha256,
        attemptIdSha256,
        failureCode: failureCode(error),
        failedAt: Math.floor(Math.max(startedAtMs, failedAtMs) / 1000),
      });
    } catch {
      throw invokerError("invocation_authority_unavailable");
    }
    if (!failure.ok || failure.status !== "invocation_campaign_failed") {
      throw invokerError("invocation_authority_unavailable");
    }
    throw error;
  }
}

async function statusResultFromAuthority(
  authority: JsonCompatibilityInvocationAttemptStatusResult & { ok: true },
  target: JsonCompatibilityInvocationStatusTargetV1,
): Promise<JsonCompatibilityPrivateInvocationStatusResultV1> {
  if (authority.status === "not_found") {
    return { status: "not_found", retryPermitted: false };
  }
  if (authority.status === "active") {
    return {
      status: "active",
      attempt: authority.attempt,
      retryPermitted: false,
    };
  }
  if (authority.status === "failed") {
    return {
      status: "failed",
      attempt: authority.attempt,
      failureCode: authority.failureCode,
      failedAt: authority.failedAt,
      retryPermitted: false,
    };
  }
  if (authority.status === "completed_receipt_unavailable") {
    return {
      status: "completed_receipt_unavailable",
      attempt: authority.attempt,
      completion: authority.completion,
      retryPermitted: false,
      executionRpcRepeated: false,
    };
  }
  const privateInvocationReceipt = await restorePrivateInvocationReceipt(
    authority,
    target,
  );
  return {
    status: "completed",
    attempt: authority.attempt,
    completion: authority.completion,
    privateInvocationReceipt,
    privateInvocationReceiptSha256: digest(
      privateInvocationReceipt.receiptSha256,
      "invalid_invocation_status",
    ),
    recoveredFromPersistedAuthority: true,
    retryPermitted: false,
    executionRpcRepeated: false,
  };
}

async function restorePrivateInvocationReceipt(
  authority: Extract<
    JsonCompatibilityInvocationAttemptStatusResult,
    { readonly ok: true; readonly status: "completed" }
  >,
  target: JsonCompatibilityInvocationStatusTargetV1,
): Promise<Readonly<Record<string, unknown>>> {
  const code = "invalid_invocation_status" as const;
  if (
    authority.invocationBodyJson.length > MAX_INVOCATION_RECEIPT_BYTES
    || new TextEncoder().encode(authority.invocationBodyJson).byteLength
      > MAX_INVOCATION_RECEIPT_BYTES - 16 * 1024
  ) {
    throw invokerError(code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(authority.invocationBodyJson);
  } catch {
    throw invokerError(code);
  }
  if (
    canonicalJson(parsed) !== authority.invocationBodyJson
    || await sha256Hex(authority.invocationBodyJson)
      !== authority.completion.invocationBodySha256
  ) {
    throw invokerError(code);
  }
  const body = statusExactRecord(parsed, [
    "schemaVersion",
    "contract",
    "status",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "phaseOrdinal",
    "phaseId",
    "command",
    "commandAuthority",
    "invoker",
    "privateTransport",
    "invocationAuthority",
    "permitIssueReceipt",
    "executorReceipt",
    "startedAt",
    "completedAt",
  ], code);
  const invocationAuthority = statusExactRecord(
    body.invocationAuthority,
    ["attempt"],
    code,
  );
  const invoker = statusExactRecord(
    body.invoker,
    ["serviceName", "versionId", "gateName"],
    code,
  );
  let command: JsonCompatibilityInvokeCommandV1;
  try {
    command = parseJsonCompatibilityInvokeCommandV1(body.command);
  } catch {
    throw invokerError(code);
  }
  const execution = command.subject.issueIntent.execution;
  if (
    body.schemaVersion !== 1
    || body.contract !== JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_CONTRACT
    || body.status !== "private_phase_invocation_completed"
    || body.environment !== "staging"
    || body.campaignIdSha256 !== target.campaignIdSha256
    || body.planDigestSha256 !== target.planDigestSha256
    || body.phaseExecutionId !== target.phaseExecutionId
    || body.phaseOrdinal !== target.phaseOrdinal
    || body.phaseId !== target.phaseId
    || command.subject.commandIdSha256 !== target.commandIdSha256
    || execution.campaignIdSha256 !== target.campaignIdSha256
    || execution.planDigestSha256 !== target.planDigestSha256
    || execution.phaseExecutionId !== target.phaseExecutionId
    || execution.phase.ordinal !== target.phaseOrdinal
    || execution.phase.id !== target.phaseId
    || invoker.serviceName !== JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || invoker.versionId !== target.invokerVersionId
    || invoker.gateName !== "JSON_COMPATIBILITY_INVOKER_ENABLED"
    || canonicalJson(invocationAuthority.attempt)
      !== canonicalJson(authority.attempt)
  ) {
    throw invokerError(code);
  }
  const receiptSubject = {
    ...body,
    invocationAuthority: {
      attempt: authority.attempt,
      completion: authority.completion,
    },
    invocationBodySha256: authority.completion.invocationBodySha256,
  };
  const canonicalSubject = canonicalJson(receiptSubject);
  if (
    new TextEncoder().encode(canonicalSubject).byteLength
      > MAX_INVOCATION_RECEIPT_BYTES
  ) {
    throw invokerError(code);
  }
  return {
    ...receiptSubject,
    receiptSha256: await sha256Hex(canonicalSubject),
  };
}

async function createPermitIssueRequest(
  env: JsonCompatibilityInvokerEnv,
  command: JsonCompatibilityInvokeCommandV1,
  issueIntentSha256: string,
  invokerVersionId: string,
  now: number,
): Promise<JsonCompatibilityPermitIssueRequestV1> {
  const secret = env.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET;
  const keyId = token(
    env.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID,
    "invoker_configuration_error",
  );
  const credentialIdSha256 = digest(
    env.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256,
    "invoker_configuration_error",
  );
  if (
    typeof secret !== "string"
    || new TextEncoder().encode(secret).byteLength < 32
    || env.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_ISSUER !==
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || env.JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_AUDIENCE !==
      JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME
  ) {
    throw invokerError("invoker_configuration_error");
  }
  const requestIdSha256 = await sha256Hex(
    `${ISSUER_REQUEST_ID_DOMAIN}${command.subject.commandIdSha256}\n${issueIntentSha256}\n${invokerVersionId}`,
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_REQUEST_CONTRACT,
    intent: command.subject.issueIntent,
    authority: await createPermitIssueAuthorityEnvelope(secret, keyId, {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_PERMIT_ISSUE_AUTHORITY_CLAIMS_CONTRACT,
      issuer: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      audience: JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
      credentialIdSha256,
      requestIdSha256,
      issueIntentSha256,
      issuedAt: now,
      expiresAt: now + 60,
    }),
  };
}

async function beginInvocationAttempt(
  authorityStub: DurableObjectStub<JsonCompatibilityInvocationAuthority>,
  command: JsonCompatibilityInvokeCommandV1,
  authority: VerifiedJsonCompatibilityInvokeAuthorityV1,
  issueIntentSha256: string,
  campaignBindingSha256: string,
  attemptIdSha256: string,
  invokerVersionId: string,
  startedAt: number,
): Promise<JsonCompatibilityInvocationAttemptReceiptV1> {
  const intent = command.subject.issueIntent;
  const execution = intent.execution;
  let result;
  try {
    result = await authorityStub.beginAttempt({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-invocation-attempt-begin-v1",
      campaignIdSha256: execution.campaignIdSha256,
      campaignBindingSha256,
      planDigestSha256: execution.planDigestSha256,
      phaseOrdinal: execution.phase.ordinal,
      phaseId: execution.phase.id,
      phaseExecutionId: execution.phaseExecutionId,
      commandIdSha256: command.subject.commandIdSha256,
      commandSubjectSha256: authority.commandSubjectSha256,
      commandAuthorityEnvelopeSha256: authority.authorityEnvelopeSha256,
      issueIntentSha256,
      topologyReadbackSha256: intent.topologyReadbackSha256,
      beforeContextSha256: intent.beforeContextSha256,
      attemptIdSha256,
      invokerVersionId,
      startedAt,
    });
  } catch {
    throw invokerError("invocation_authority_unavailable");
  }
  if (!result.ok) throw authorityConflict(result.error.code);
  const receipt = result.receipt;
  const { receiptSha256, ...receiptSubject } = receipt;
  const expectedSubject = {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-receipt-v1" as const,
    status: "invocation_attempt_recorded" as const,
    campaignIdSha256: execution.campaignIdSha256,
    campaignBindingSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseId: execution.phase.id,
    phaseExecutionId: execution.phaseExecutionId,
    commandIdSha256: command.subject.commandIdSha256,
    commandSubjectSha256: authority.commandSubjectSha256,
    commandAuthorityEnvelopeSha256: authority.authorityEnvelopeSha256,
    issueIntentSha256,
    topologyReadbackSha256: intent.topologyReadbackSha256,
    beforeContextSha256: intent.beforeContextSha256,
    attemptIdSha256,
    invokerVersionId,
    startedAt,
    oneAttemptPerPhasePersisted: true as const,
    phaseOrderEnforced: true as const,
    ambiguousRetryRejected: true as const,
  };
  if (
    canonicalJson(receiptSubject) !== canonicalJson(expectedSubject)
    || receiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw invokerError("invocation_authority_unavailable");
  }
  return receipt;
}

async function validatePermitIssueReceipt(
  env: JsonCompatibilityInvokerEnv,
  input: unknown,
  intent: JsonCompatibilityInvokeCommandV1["subject"]["issueIntent"],
  issueIntentSha256: string,
  request: JsonCompatibilityPermitIssueRequestV1,
  nowMilliseconds: number,
): Promise<JsonCompatibilityPermitIssueReceiptV1> {
  const code = "invalid_permit_issue_receipt" as const;
  const value = exactRecord(input, [
    "schemaVersion", "contract", "status", "environment",
    "campaignIdSha256", "phaseOrdinal", "phaseExecutionId", "issuer",
    "authority", "issueIntent", "issueIntentSha256", "permitEnvelope",
    "permitEnvelopeSha256", "issuanceAuthority", "receiptSha256",
  ], code);
  let parsedIntent;
  let parsedExecuteRequest;
  try {
    parsedIntent = parseJsonCompatibilityPermitIssueIntentV1(value.issueIntent);
    parsedExecuteRequest = parseJsonCompatibilityExecutePhaseRequestV2({
      ...parsedIntent.execution,
      authorization: value.permitEnvelope,
    });
  } catch {
    throw invokerError(code);
  }
  const issuerValue = exactRecord(value.issuer, [
    "serviceName", "versionId", "keyId", "signerSpkiSha256",
  ], code);
  const authorityValue = exactRecord(value.authority, [
    "issuer", "audience", "keyId", "credentialIdSha256",
    "requestIdSha256", "claimsSha256",
  ], code);
  const issuanceAuthority = parsePermitIssuanceReceipt(
    value.issuanceAuthority,
    code,
  );
  const receiptSubject = {
    schemaVersion: literalValue(value.schemaVersion, 1, code),
    contract: literalValue(
      value.contract,
      JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT,
      code,
    ),
    status: literalValue(value.status, "phase_permit_issued", code),
    environment: literalValue(value.environment, "staging", code),
    campaignIdSha256: digest(value.campaignIdSha256, code),
    phaseOrdinal: boundedInteger(value.phaseOrdinal, 1, 4, code) as 1 | 2 | 3 | 4,
    phaseExecutionId: token(value.phaseExecutionId, code),
    issuer: {
      serviceName: literalValue(
        issuerValue.serviceName,
        JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
        code,
      ),
      versionId: token(issuerValue.versionId, code),
      keyId: keyId(issuerValue.keyId, code),
      signerSpkiSha256: digest(issuerValue.signerSpkiSha256, code),
    },
    authority: {
      issuer: token(authorityValue.issuer, code),
      audience: token(authorityValue.audience, code),
      keyId: keyId(authorityValue.keyId, code),
      credentialIdSha256: digest(authorityValue.credentialIdSha256, code),
      requestIdSha256: digest(authorityValue.requestIdSha256, code),
      claimsSha256: digest(authorityValue.claimsSha256, code),
    },
    issueIntent: parsedIntent,
    issueIntentSha256: digest(value.issueIntentSha256, code),
    permitEnvelope: parsedExecuteRequest.authorization,
    permitEnvelopeSha256: digest(value.permitEnvelopeSha256, code),
    issuanceAuthority,
  };
  const receiptSha256 = digest(value.receiptSha256, code);
  const receipt: JsonCompatibilityPermitIssueReceiptV1 = {
    ...receiptSubject,
    receiptSha256,
  };
  const issueIntentCanonicalSha256 = await sha256Hex(canonicalJson(parsedIntent));
  const permitEnvelopeCanonicalSha256 = await sha256Hex(
    canonicalJson(parsedExecuteRequest.authorization),
  );
  if (
    canonicalJson(receipt.issueIntent) !== canonicalJson(intent)
    || issueIntentCanonicalSha256 !== issueIntentSha256
    || receipt.issueIntentSha256 !== issueIntentCanonicalSha256
    || receipt.campaignIdSha256 !== intent.execution.campaignIdSha256
    || receipt.phaseOrdinal !== intent.execution.phase.ordinal
    || receipt.phaseExecutionId !== intent.execution.phaseExecutionId
    || receipt.issuer.keyId !== env.JSON_COMPATIBILITY_PERMIT_KEY_ID
    || receipt.issuer.signerSpkiSha256 !==
      env.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256
    || receipt.authority.issuer !== request.authority.claims.issuer
    || receipt.authority.audience !== request.authority.claims.audience
    || receipt.authority.keyId !== request.authority.keyId
    || receipt.authority.credentialIdSha256 !==
      request.authority.claims.credentialIdSha256
    || receipt.authority.requestIdSha256 !== request.authority.claims.requestIdSha256
    || receipt.authority.claimsSha256 !== request.authority.claimsSha256
    || receipt.permitEnvelopeSha256 !== permitEnvelopeCanonicalSha256
    || receiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw invokerError(code);
  }
  const expectedPermitId = await deriveJsonCompatibilityPermitIdSha256(
    issueIntentSha256,
    request.authority.claims.requestIdSha256,
  );
  if (receipt.permitEnvelope.subject.permitIdSha256 !== expectedPermitId) {
    throw invokerError(code);
  }
  await validatePermitIssuanceBinding(
    issuanceAuthority,
    receipt,
    request,
  );
  try {
    await verifyJsonCompatibilityPhasePermit(
      env,
      {
        ...intent.execution,
        authorization: receipt.permitEnvelope,
      },
      intent.executor.versionId,
      nowMilliseconds,
    );
  } catch {
    throw invokerError(code);
  }
  return receipt;
}

function parsePermitIssuanceReceipt(
  input: unknown,
  code: "invalid_permit_issue_receipt",
): JsonCompatibilityPermitIssuanceReceiptV1 {
  const value = exactRecord(input, [
    "schemaVersion", "contract", "status", "campaignIdSha256",
    "campaignBindingSha256", "planDigestSha256", "phaseOrdinal", "phaseId",
    "phaseExecutionId", "issueIntentSha256", "authorityRequestIdSha256",
    "permitIdSha256", "permitSubjectSha256", "permitEnvelopeSha256",
    "issuerVersionId", "issuedAt", "expiresAt", "onePermitPerPhasePersisted",
    "phaseIssuanceOrderEnforced", "ambiguousRetryRejected", "receiptSha256",
  ], code);
  const phaseOrdinal = boundedInteger(value.phaseOrdinal, 1, 4, code) as
    1 | 2 | 3 | 4;
  const phaseIdValue = phaseId(value.phaseId, code);
  if (JSON_COMPATIBILITY_PHASE_IDS[phaseOrdinal - 1] !== phaseIdValue) {
    throw invokerError(code);
  }
  return {
    schemaVersion: literalValue(value.schemaVersion, 1, code),
    contract: literalValue(
      value.contract,
      JSON_COMPATIBILITY_PERMIT_ISSUANCE_RECEIPT_CONTRACT,
      code,
    ),
    status: literalValue(value.status, "permit_issuance_recorded", code),
    campaignIdSha256: digest(value.campaignIdSha256, code),
    campaignBindingSha256: digest(value.campaignBindingSha256, code),
    planDigestSha256: digest(value.planDigestSha256, code),
    phaseOrdinal,
    phaseId: phaseIdValue,
    phaseExecutionId: token(value.phaseExecutionId, code),
    issueIntentSha256: digest(value.issueIntentSha256, code),
    authorityRequestIdSha256: digest(value.authorityRequestIdSha256, code),
    permitIdSha256: digest(value.permitIdSha256, code),
    permitSubjectSha256: digest(value.permitSubjectSha256, code),
    permitEnvelopeSha256: digest(value.permitEnvelopeSha256, code),
    issuerVersionId: token(value.issuerVersionId, code),
    issuedAt: boundedInteger(value.issuedAt, 1, Number.MAX_SAFE_INTEGER, code),
    expiresAt: boundedInteger(value.expiresAt, 1, Number.MAX_SAFE_INTEGER, code),
    onePermitPerPhasePersisted: literalValue(
      value.onePermitPerPhasePersisted,
      true,
      code,
    ),
    phaseIssuanceOrderEnforced: literalValue(
      value.phaseIssuanceOrderEnforced,
      true,
      code,
    ),
    ambiguousRetryRejected: literalValue(
      value.ambiguousRetryRejected,
      true,
      code,
    ),
    receiptSha256: digest(value.receiptSha256, code),
  };
}

async function validatePermitIssuanceBinding(
  issuance: JsonCompatibilityPermitIssuanceReceiptV1,
  receipt: JsonCompatibilityPermitIssueReceiptV1,
  request: JsonCompatibilityPermitIssueRequestV1,
): Promise<void> {
  const intent = receipt.issueIntent;
  const execution = intent.execution;
  const { receiptSha256, ...receiptSubject } = issuance;
  const expectedSubject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUANCE_RECEIPT_CONTRACT,
    status: "permit_issuance_recorded" as const,
    campaignIdSha256: execution.campaignIdSha256,
    campaignBindingSha256: await jsonCompatibilityIssuerCampaignBinding(intent),
    planDigestSha256: execution.planDigestSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseId: execution.phase.id,
    phaseExecutionId: execution.phaseExecutionId,
    issueIntentSha256: receipt.issueIntentSha256,
    authorityRequestIdSha256: request.authority.claims.requestIdSha256,
    permitIdSha256: receipt.permitEnvelope.subject.permitIdSha256,
    permitSubjectSha256: receipt.permitEnvelope.subjectSha256,
    permitEnvelopeSha256: receipt.permitEnvelopeSha256,
    issuerVersionId: receipt.issuer.versionId,
    issuedAt: intent.issuedAt,
    expiresAt: intent.expiresAt,
    onePermitPerPhasePersisted: true as const,
    phaseIssuanceOrderEnforced: true as const,
    ambiguousRetryRejected: true as const,
  };
  if (
    canonicalJson(receiptSubject) !== canonicalJson(expectedSubject)
    || receiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw invokerError("invalid_permit_issue_receipt");
  }
}

async function validateCompletionReceipt(
  receipt: JsonCompatibilityInvocationCompletionReceiptV1,
  expected: {
    readonly campaignIdSha256: string;
    readonly phaseOrdinal: 1 | 2 | 3 | 4;
    readonly phaseExecutionId: string;
    readonly commandIdSha256: string;
    readonly attemptIdSha256: string;
    readonly permitIdSha256: string;
    readonly permitIssueReceiptSha256: string;
    readonly executorReceiptSha256: string;
    readonly invocationBodySha256: string;
    readonly completedAt: number;
    readonly status:
      | "invocation_phase_completed"
      | "invocation_campaign_completed";
  },
): Promise<void> {
  const { receiptSha256, ...receiptSubject } = receipt;
  const expectedSubject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_INVOCATION_COMPLETION_RECEIPT_CONTRACT,
    status: expected.status,
    campaignIdSha256: expected.campaignIdSha256,
    phaseOrdinal: expected.phaseOrdinal,
    phaseExecutionId: expected.phaseExecutionId,
    commandIdSha256: expected.commandIdSha256,
    attemptIdSha256: expected.attemptIdSha256,
    permitIdSha256: expected.permitIdSha256,
    permitIssueReceiptSha256: expected.permitIssueReceiptSha256,
    executorReceiptSha256: expected.executorReceiptSha256,
    invocationBodySha256: expected.invocationBodySha256,
    completedAt: expected.completedAt,
    attemptCompletionPersisted: true as const,
    phaseOrderAdvanced: true as const,
    campaignTerminal: expected.status === "invocation_campaign_completed",
  };
  if (
    canonicalJson(receiptSubject) !== canonicalJson(expectedSubject)
    || receiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw invokerError("invocation_authority_unavailable");
  }
}

async function validateExecutorReceipt(
  input: unknown,
  request: JsonCompatibilityExecutePhaseRequestV2,
  executorVersionId: string,
): Promise<JsonCompatibilityPhaseProbeReceiptV2> {
  const code = "invalid_executor_receipt" as const;
  const value = exactRecord(input, [
    "schemaVersion", "contract", "kind", "environment", "campaignIdSha256",
    "planDigestSha256", "phaseExecutionId", "controller", "runtimes", "ring",
    "phase", "authorization", "executor", "transport", "startedAt",
    "completedAt", "observations", "transportTotals", "executionBoundary",
    "receiptSha256",
  ], code);
  let echoedRequest;
  try {
    echoedRequest = parseJsonCompatibilityExecutePhaseRequestV2({
      ...request,
      controller: value.controller,
      runtimes: value.runtimes,
      ring: value.ring,
      phase: value.phase,
    });
  } catch {
    throw invokerError(code);
  }
  const authorizationValue = exactRecord(value.authorization, [
    "kind", "algorithm", "permitIdSha256", "permitSubjectSha256",
    "permitEnvelopeSha256", "permitEnvelope", "issuer", "audience", "keyId",
    "signerSpkiSha256", "issuedAt", "notBefore", "expiresAt",
    "campaignAuthority",
  ], code);
  let parsedPermitRequest;
  try {
    parsedPermitRequest = parseJsonCompatibilityExecutePhaseRequestV2({
      ...request,
      authorization: authorizationValue.permitEnvelope,
    });
  } catch {
    throw invokerError(code);
  }
  const campaignAuthorityValue = exactRecord(
    authorizationValue.campaignAuthority,
    [
      "kind", "binding", "objectNameSha256", "campaignBindingSha256",
      "leaseIdSha256", "leaseReceiptSha256", "singleUsePermitPersisted",
      "phaseOrderEnforced", "concurrentPhaseRejected",
    ],
    code,
  );
  const executorValue = exactRecord(value.executor, [
    "serviceName", "versionId", "gateName", "maxConcurrency",
  ], code);
  const transportValue = exactRecord(value.transport, [
    "kind", "binding", "targetService", "targetEntrypoint", "rpcMethod",
    "publicUrlUsed", "cloudflareRestUsed",
  ], code);
  const totalsValue = exactRecord(value.transportTotals, [
    "privateServiceBindingRpcCount", "completedProbeCount", "selectedJsonCount",
    "effectiveJsonCount", "protobufAttemptCount", "legacyJsonFallbackCount",
    "recoveryRequiredCount",
  ], code);
  const boundaryValue = exactRecord(value.executionBoundary, [
    "credentialsRead", "filesWritten", "deploymentMutationAuthorized",
    "deploymentMutationPerformed", "cloudflareRestRequestCount",
    "providerRequestCount", "billingMutationCount", "storageGatewayMutationCount",
    "productionTrafficRequestCount", "publicProbeRequestCount",
  ], code);
  if (!Array.isArray(value.observations) || value.observations.length !== 8) {
    throw invokerError(code);
  }
  const observations: JsonCompatibilityPhaseProbeObservationV1[] = [];
  for (let index = 0; index < value.observations.length; index += 1) {
    observations.push(await parseExecutorObservation(
      value.observations[index],
      request,
      index,
    ));
  }
  const startedAt = utcTimestamp(value.startedAt, code);
  const completedAt = utcTimestamp(value.completedAt, code);
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw invokerError(code);
  }
  const authorization = {
    kind: literalValue(
      authorizationValue.kind,
      "ed25519-signed-single-use-phase-permit",
      code,
    ),
    algorithm: literalValue(authorizationValue.algorithm, "Ed25519", code),
    permitIdSha256: digest(authorizationValue.permitIdSha256, code),
    permitSubjectSha256: digest(authorizationValue.permitSubjectSha256, code),
    permitEnvelopeSha256: digest(authorizationValue.permitEnvelopeSha256, code),
    permitEnvelope: parsedPermitRequest.authorization,
    issuer: token(authorizationValue.issuer, code),
    audience: token(authorizationValue.audience, code),
    keyId: keyId(authorizationValue.keyId, code),
    signerSpkiSha256: digest(authorizationValue.signerSpkiSha256, code),
    issuedAt: boundedInteger(
      authorizationValue.issuedAt,
      1,
      Number.MAX_SAFE_INTEGER,
      code,
    ),
    notBefore: boundedInteger(
      authorizationValue.notBefore,
      1,
      Number.MAX_SAFE_INTEGER,
      code,
    ),
    expiresAt: boundedInteger(
      authorizationValue.expiresAt,
      1,
      Number.MAX_SAFE_INTEGER,
      code,
    ),
    campaignAuthority: {
      kind: literalValue(
        campaignAuthorityValue.kind,
        "campaign-scoped-sqlite-durable-object",
        code,
      ),
      binding: literalValue(
        campaignAuthorityValue.binding,
        "JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY",
        code,
      ),
      objectNameSha256: digest(campaignAuthorityValue.objectNameSha256, code),
      campaignBindingSha256: digest(
        campaignAuthorityValue.campaignBindingSha256,
        code,
      ),
      leaseIdSha256: digest(campaignAuthorityValue.leaseIdSha256, code),
      leaseReceiptSha256: digest(campaignAuthorityValue.leaseReceiptSha256, code),
      singleUsePermitPersisted: literalValue(
        campaignAuthorityValue.singleUsePermitPersisted,
        true,
        code,
      ),
      phaseOrderEnforced: literalValue(
        campaignAuthorityValue.phaseOrderEnforced,
        true,
        code,
      ),
      concurrentPhaseRejected: literalValue(
        campaignAuthorityValue.concurrentPhaseRejected,
        true,
        code,
      ),
    },
  };
  const receiptSubject = {
    schemaVersion: literalValue(value.schemaVersion, 2, code),
    contract: literalValue(
      value.contract,
      JSON_COMPATIBILITY_PHASE_PROBE_RECEIPT_CONTRACT,
      code,
    ),
    kind: literalValue(
      value.kind,
      "container-runtime-json-compatibility-phase-probe-receipt",
      code,
    ),
    environment: literalValue(value.environment, "staging", code),
    campaignIdSha256: digest(value.campaignIdSha256, code),
    planDigestSha256: digest(value.planDigestSha256, code),
    phaseExecutionId: token(value.phaseExecutionId, code),
    controller: echoedRequest.controller,
    runtimes: echoedRequest.runtimes,
    ring: echoedRequest.ring,
    phase: echoedRequest.phase,
    authorization,
    executor: {
      serviceName: literalValue(
        executorValue.serviceName,
        JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
        code,
      ),
      versionId: token(executorValue.versionId, code),
      gateName: literalValue(
        executorValue.gateName,
        "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
        code,
      ),
      maxConcurrency: literalValue(
        executorValue.maxConcurrency,
        JSON_COMPATIBILITY_MAX_CONCURRENCY,
        code,
      ),
    },
    transport: {
      kind: literalValue(transportValue.kind, "service-binding-rpc", code),
      binding: literalValue(
        transportValue.binding,
        "CONTAINER_CONTROLLER_JSON_PROBE",
        code,
      ),
      targetService: literalValue(
        transportValue.targetService,
        JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME,
        code,
      ),
      targetEntrypoint: literalValue(
        transportValue.targetEntrypoint,
        JSON_COMPATIBILITY_CONTROLLER_ENTRYPOINT,
        code,
      ),
      rpcMethod: literalValue(transportValue.rpcMethod, "probeShard", code),
      publicUrlUsed: literalValue(transportValue.publicUrlUsed, false, code),
      cloudflareRestUsed: literalValue(
        transportValue.cloudflareRestUsed,
        false,
        code,
      ),
    },
    startedAt,
    completedAt,
    observations,
    transportTotals: {
      privateServiceBindingRpcCount: literalValue(
        totalsValue.privateServiceBindingRpcCount,
        8,
        code,
      ),
      completedProbeCount: literalValue(totalsValue.completedProbeCount, 8, code),
      selectedJsonCount: literalValue(totalsValue.selectedJsonCount, 8, code),
      effectiveJsonCount: literalValue(totalsValue.effectiveJsonCount, 8, code),
      protobufAttemptCount: literalValue(totalsValue.protobufAttemptCount, 0, code),
      legacyJsonFallbackCount: literalValue(
        totalsValue.legacyJsonFallbackCount,
        0,
        code,
      ),
      recoveryRequiredCount: literalValue(
        totalsValue.recoveryRequiredCount,
        0,
        code,
      ),
    },
    executionBoundary: {
      credentialsRead: literalValue(boundaryValue.credentialsRead, false, code),
      filesWritten: literalValue(boundaryValue.filesWritten, false, code),
      deploymentMutationAuthorized: literalValue(
        boundaryValue.deploymentMutationAuthorized,
        false,
        code,
      ),
      deploymentMutationPerformed: literalValue(
        boundaryValue.deploymentMutationPerformed,
        false,
        code,
      ),
      cloudflareRestRequestCount: literalValue(
        boundaryValue.cloudflareRestRequestCount,
        0,
        code,
      ),
      providerRequestCount: literalValue(boundaryValue.providerRequestCount, 0, code),
      billingMutationCount: literalValue(boundaryValue.billingMutationCount, 0, code),
      storageGatewayMutationCount: literalValue(
        boundaryValue.storageGatewayMutationCount,
        0,
        code,
      ),
      productionTrafficRequestCount: literalValue(
        boundaryValue.productionTrafficRequestCount,
        0,
        code,
      ),
      publicProbeRequestCount: literalValue(
        boundaryValue.publicProbeRequestCount,
        0,
        code,
      ),
    },
  };
  const receiptSha256 = digest(value.receiptSha256, code);
  const receipt: JsonCompatibilityPhaseProbeReceiptV2 = {
    ...receiptSubject,
    receiptSha256,
  };
  const permitSubject = request.authorization.subject;
  const expectedCampaignBindingSha256 = await sha256Hex(canonicalJson({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-binding-v1",
    environment: request.environment,
    campaignIdSha256: request.campaignIdSha256,
    planDigestSha256: request.planDigestSha256,
    controller: request.controller,
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: executorVersionId,
    },
    runtimes: request.runtimes,
    ring: request.ring,
  }));
  if (
    receipt.campaignIdSha256 !== request.campaignIdSha256
    || receipt.planDigestSha256 !== request.planDigestSha256
    || receipt.phaseExecutionId !== request.phaseExecutionId
    || canonicalJson(receipt.controller) !== canonicalJson(request.controller)
    || canonicalJson(receipt.runtimes) !== canonicalJson(request.runtimes)
    || canonicalJson(receipt.ring) !== canonicalJson(request.ring)
    || canonicalJson(receipt.phase) !== canonicalJson(request.phase)
    || receipt.executor.versionId !== executorVersionId
    || receipt.authorization.permitIdSha256 !== permitSubject.permitIdSha256
    || receipt.authorization.permitSubjectSha256 !==
      request.authorization.subjectSha256
    || receipt.authorization.permitEnvelopeSha256 !==
      await sha256Hex(canonicalJson(request.authorization))
    || canonicalJson(receipt.authorization.permitEnvelope) !==
      canonicalJson(request.authorization)
    || receipt.authorization.issuer !== permitSubject.issuer
    || receipt.authorization.audience !== permitSubject.audience
    || receipt.authorization.keyId !== permitSubject.keyId
    || receipt.authorization.issuedAt !== permitSubject.issuedAt
    || receipt.authorization.notBefore !== permitSubject.notBefore
    || receipt.authorization.expiresAt !== permitSubject.expiresAt
    || receipt.authorization.campaignAuthority.objectNameSha256 !==
      request.campaignIdSha256
    || receipt.authorization.campaignAuthority.campaignBindingSha256 !==
      expectedCampaignBindingSha256
    || receiptSha256 !== await sha256Hex(canonicalJson(receiptSubject))
  ) {
    throw invokerError(code);
  }
  return receipt;
}

async function parseExecutorObservation(
  input: unknown,
  request: JsonCompatibilityExecutePhaseRequestV2,
  expectedShardIndex: number,
): Promise<JsonCompatibilityPhaseProbeObservationV1> {
  const code = "invalid_executor_receipt" as const;
  const value = exactRecord(input, [
    "shardIndex", "instanceName", "runtimeGeneration", "runtimeBuildIdSha256",
    "probeRequestCanonicalSha256", "probeResultCanonicalSha256", "probeResult",
  ], code);
  const shardIndex = boundedInteger(
    value.shardIndex,
    0,
    JSON_COMPATIBILITY_SHARD_COUNT - 1,
    code,
  );
  if (shardIndex !== expectedShardIndex) throw invokerError(code);
  let probeResult;
  try {
    probeResult = await verifyJsonCompatibilityProbeResultDigests(value.probeResult);
  } catch {
    throw invokerError(code);
  }
  const runtimeGeneration = expectedRuntimeGeneration(
    request.phase.id,
    request.ring.candidateShardIndex,
    shardIndex,
  );
  const runtime = runtimeGeneration === "n"
    ? request.runtimes.n
    : request.runtimes.nMinusOne;
  const instanceName = jsonCompatibilityShardInstanceName(shardIndex);
  const probeRequest = probeResult.request;
  const observation = {
    shardIndex,
    instanceName: literalValue(value.instanceName, instanceName, code),
    runtimeGeneration: literalValue(
      value.runtimeGeneration,
      runtimeGeneration,
      code,
    ),
    runtimeBuildIdSha256: digest(value.runtimeBuildIdSha256, code),
    probeRequestCanonicalSha256: digest(
      value.probeRequestCanonicalSha256,
      code,
    ),
    probeResultCanonicalSha256: digest(
      value.probeResultCanonicalSha256,
      code,
    ),
    probeResult,
  };
  if (
    observation.runtimeBuildIdSha256 !== runtime.buildIdSha256
    || observation.probeRequestCanonicalSha256 !==
      await sha256Hex(canonicalJson(probeRequest))
    || observation.probeResultCanonicalSha256 !==
      await sha256Hex(canonicalJson(probeResult))
    || probeRequest.environment !== "staging"
    || probeRequest.campaignIdSha256 !== request.campaignIdSha256
    || probeRequest.planDigestSha256 !== request.planDigestSha256
    || probeRequest.phaseId !== request.phase.id
    || probeRequest.phaseOrdinal !== request.phase.ordinal
    || probeRequest.candidateShardIndex !== request.ring.candidateShardIndex
    || probeRequest.controllerServiceName !==
      JSON_COMPATIBILITY_CONTROLLER_SERVICE_NAME
    || probeRequest.controllerVersionId !== request.controller.versionId
    || probeRequest.runtimeGeneration !== runtimeGeneration
    || probeRequest.expectedRuntimeBuildIdSha256 !== runtime.buildIdSha256
    || probeRequest.shard.ringGeneration !== request.ring.generation
    || probeRequest.shard.shardCount !== JSON_COMPATIBILITY_SHARD_COUNT
    || probeRequest.shard.shardIndex !== shardIndex
    || probeRequest.shard.instanceName !== instanceName
    || probeResult.sideEffects.providerRequestCount !== 0
    || probeResult.sideEffects.billingMutationCount !== 0
    || probeResult.sideEffects.storageGatewayMutationCount !== 0
    || probeResult.sideEffects.productionTrafficRequestCount !== 0
    || probeResult.sideEffects.publicProbeRequestCount !== 0
  ) {
    throw invokerError(code);
  }
  return observation;
}

function requireInvokerEnvironment(env: JsonCompatibilityInvokerEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_INVOKER_ENABLED !== "true"
  ) {
    throw invokerError("invoker_disabled");
  }
  if (
    env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY === null
    || typeof env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY !== "object"
    || typeof env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY.getByName !== "function"
    || env.JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE === null
    || typeof env.JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE !== "object"
    || typeof env.JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE.issuePhasePermit !==
      "function"
    || env.JSON_COMPATIBILITY_EXECUTOR_SERVICE === null
    || typeof env.JSON_COMPATIBILITY_EXECUTOR_SERVICE !== "object"
    || typeof env.JSON_COMPATIBILITY_EXECUTOR_SERVICE.executePhase !== "function"
  ) {
    throw invokerError("invoker_configuration_error");
  }
}

function requireInvokerStatusEnvironment(env: JsonCompatibilityInvokerEnv): void {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED !== "true"
  ) {
    throw invokerError("invocation_status_disabled");
  }
  if (
    env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY === null
    || typeof env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY !== "object"
    || typeof env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY.getByName !== "function"
  ) {
    throw invokerError("invoker_configuration_error");
  }
}

function authorityConflict(
  _code: JsonCompatibilityInvocationAuthorityErrorCode,
): JsonCompatibilityInvokerError {
  return invokerError("invocation_authority_conflict");
}

function failureCode(error: unknown): string {
  if (error instanceof JsonCompatibilityInvokerError) return error.code;
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    && SAFE_TOKEN.test(error.code)
  ) {
    return error.code;
  }
  return "private_invocation_failed";
}

function hasRemoteCode(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string";
}

function record(
  value: unknown,
  code: "invalid_permit_issue_receipt" | "invalid_executor_receipt",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invokerError(code);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: "invalid_permit_issue_receipt" | "invalid_executor_receipt",
): Record<string, unknown> {
  const result = record(value, code);
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invokerError(code);
  }
  return result;
}

function statusExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: "invalid_invocation_status",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invokerError(code);
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invokerError(code);
  }
  return result;
}

function literalValue<const T>(
  value: unknown,
  expected: T,
  code: JsonCompatibilityInvokerError["code"],
): T {
  if (value !== expected) throw invokerError(code);
  return expected;
}

function token(
  value: unknown,
  code: JsonCompatibilityInvokerError["code"],
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw invokerError(code);
  }
  return value;
}

function digest(
  value: unknown,
  code: JsonCompatibilityInvokerError["code"],
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw invokerError(code);
  }
  return value;
}

function keyId(
  value: unknown,
  code: JsonCompatibilityInvokerError["code"],
): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw invokerError(code);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: JsonCompatibilityInvokerError["code"],
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw invokerError(code);
  }
  return value;
}

function phaseId(
  value: unknown,
  code: JsonCompatibilityInvokerError["code"],
): JsonCompatibilityPhaseId {
  if (
    typeof value !== "string"
    || !JSON_COMPATIBILITY_PHASE_IDS.includes(value as JsonCompatibilityPhaseId)
  ) {
    throw invokerError(code);
  }
  return value as JsonCompatibilityPhaseId;
}

function utcTimestamp(
  value: unknown,
  code: JsonCompatibilityInvokerError["code"],
): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw invokerError(code);
  }
  return value;
}

function runtimeNow(runtime: JsonCompatibilityInvokerRuntime, _label: string): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invokerError("invoker_configuration_error");
  }
  return value;
}

function wholeSecondUtc(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function invokerError(
  code: JsonCompatibilityInvokerError["code"],
): JsonCompatibilityInvokerError {
  return new JsonCompatibilityInvokerError(code);
}
