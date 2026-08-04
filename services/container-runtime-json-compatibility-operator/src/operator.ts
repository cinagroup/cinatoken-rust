import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
  parseJsonCompatibilityExecutePhaseRequestV2,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
  JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
  jsonCompatibilityIssuerCampaignBinding,
  parseJsonCompatibilityPermitIssueIntentV1,
  type JsonCompatibilityPermitIssueIntentV1,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
  JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
  JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
  createInvokeAuthorityEnvelope,
  parseJsonCompatibilityInvokeCommandV1,
  type JsonCompatibilityInvokeCommandV1,
} from "../../container-runtime-json-compatibility-invoker/src/authorization";
import {
  JsonCompatibilityOperatorApprovalError,
  verifyJsonCompatibilityOperatorApproval,
} from "./authorization";
import {
  JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
  parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorPhaseApprovalEnvelopeV1,
  type JsonCompatibilityOperatorCallerV1,
  type JsonCompatibilityOperatorPhaseRequestV1,
} from "./protocol";

export const JSON_COMPATIBILITY_OPERATOR_ISSUER =
  "cinatoken-json-compatibility-campaign-operator-staging" as const;
export const COMMAND_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-operator-command-id-v1\n" as const;

const INVOCATION_ATTEMPT_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-id-v1\n";
const PRIVATE_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1";
const INVOCATION_ATTEMPT_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-receipt-v1";
const INVOCATION_COMPLETION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-completion-receipt-v1";
const PERMIT_WINDOW_SECONDS = 300;
const HMAC_WINDOW_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const MAX_PRIVATE_INVOCATION_RECEIPT_BYTES = 1536 * 1024;
const MAX_OPERATOR_INVOCATION_RECEIPT_BYTES = 1792 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilityInvokerServiceBinding {
  invokePhase(input: unknown): Promise<unknown>;
}

interface OperatorSecrets {
  readonly JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET?: string;
}

type WidenGeneratedStringBindings<GeneratedEnv> = {
  [Key in keyof GeneratedEnv]: GeneratedEnv[Key] extends string
    ? string
    : GeneratedEnv[Key];
};

export type JsonCompatibilityOperatorEnv = Omit<
  WidenGeneratedStringBindings<JsonCompatibilityOperatorGeneratedEnv>,
  | "CF_VERSION_METADATA"
  | "JSON_COMPATIBILITY_INVOKER_SERVICE"
> & {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly JSON_COMPATIBILITY_INVOKER_SERVICE:
    JsonCompatibilityInvokerServiceBinding;
} & OperatorSecrets;

export interface JsonCompatibilityOperatorRuntime {
  now(): number;
}

export interface JsonCompatibilityOperatorInvocationReceiptV2 {
  readonly schemaVersion: 1;
  readonly contract:
    typeof JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT;
  readonly status: "operator_phase_invocation_completed";
  readonly environment: "staging";
  readonly campaignIdSha256: string;
  readonly planDigestSha256: string;
  readonly phaseExecutionId: string;
  readonly phaseOrdinal: 1 | 2 | 3 | 4;
  readonly phaseId: string;
  readonly operator: {
    readonly serviceName: typeof JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME;
    readonly versionId: string;
    readonly gateName: "JSON_COMPATIBILITY_OPERATOR_ENABLED";
  };
  readonly authorization: {
    readonly contract:
      typeof JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT;
    readonly approvalEnvelope: JsonCompatibilityOperatorPhaseApprovalEnvelopeV1;
    readonly approvalEnvelopeSha256: string;
    readonly approvalSubjectSha256: string;
    readonly issuer: string;
    readonly audience: typeof JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME;
    readonly keyId: string;
    readonly signerSpkiSha256: string;
    readonly caller: JsonCompatibilityOperatorCallerV1;
    readonly issuedAt: number;
    readonly notBefore: number;
    readonly expiresAt: number;
  };
  readonly request: JsonCompatibilityOperatorPhaseRequestV1;
  readonly requestSha256: string;
  readonly commandIdSha256: string;
  readonly privateTransport: {
    readonly kind: "service-binding-rpc";
    readonly publicUrlUsed: false;
    readonly cloudflareRestUsed: false;
    readonly invokerBinding: "JSON_COMPATIBILITY_INVOKER_SERVICE";
  };
  readonly privateInvocationReceipt: Readonly<Record<string, unknown>>;
  readonly privateInvocationReceiptSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly operatorBodySha256: string;
  readonly receiptSha256: string;
}

export class JsonCompatibilityOperatorError extends Error {
  constructor(
    readonly code:
      | "operator_disabled"
      | "operator_configuration_error"
      | "invalid_operator_phase_request"
      | "invalid_operator_phase_approval"
      | "operator_phase_approval_time_window"
      | "operator_approval_verifier_unavailable"
      | "invoker_rejected"
      | "invoker_unavailable"
      | "invalid_private_invocation_receipt"
      | "operator_receipt_too_large",
  ) {
    super(code);
    this.name = "JsonCompatibilityOperatorError";
  }
}

interface OperatorConfiguration {
  readonly operatorVersionId: string;
  readonly issuer: typeof JSON_COMPATIBILITY_OPERATOR_ISSUER;
  readonly audience: typeof JSON_COMPATIBILITY_INVOKER_SERVICE_NAME;
  readonly keyId: string;
  readonly credentialIdSha256: string;
  readonly secret: string;
  readonly invokerVersionId: string;
}

interface ValidatedPrivateInvocation {
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly startedAtSeconds: number;
  readonly completedAtSeconds: number;
}

export async function invokeJsonCompatibilityOperatorPhase(
  env: JsonCompatibilityOperatorEnv,
  input: unknown,
  runtime: JsonCompatibilityOperatorRuntime = { now: () => Date.now() },
): Promise<JsonCompatibilityOperatorInvocationReceiptV2> {
  const configuration = requireOperatorEnvironment(env);
  const startedAtMs = runtimeNow(runtime);
  let authorized: JsonCompatibilityOperatorAuthorizedPhaseRequestV1;
  try {
    authorized = parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(input);
  } catch {
    throw operatorError("invalid_operator_phase_request");
  }
  const request = authorized.request;
  if (request.invoker.versionId !== configuration.invokerVersionId) {
    throw operatorError("invalid_operator_phase_request");
  }

  const requestSha256 = await sha256Hex(canonicalJson(request));
  const commandIdSha256 = await deriveJsonCompatibilityOperatorCommandId(
    request,
    configuration.operatorVersionId,
  );
  let approval;
  try {
    approval = await verifyJsonCompatibilityOperatorApproval(
      env,
      authorized,
      configuration.operatorVersionId,
      requestSha256,
      commandIdSha256,
      startedAtMs,
    );
  } catch (error) {
    if (error instanceof JsonCompatibilityOperatorApprovalError) {
      throw operatorError(error.code);
    }
    throw operatorError("operator_approval_verifier_unavailable");
  }
  const issuedAt = Math.floor(startedAtMs / 1000);
  const command = await createInvokeCommand(
    request,
    commandIdSha256,
    issuedAt,
    configuration,
  );

  let rawPrivateReceipt: unknown;
  try {
    rawPrivateReceipt = await env.JSON_COMPATIBILITY_INVOKER_SERVICE
      .invokePhase(command);
  } catch (error) {
    if (hasKnownInvokerRejection(error)) {
      throw operatorError("invoker_rejected");
    }
    throw operatorError("invoker_unavailable");
  }

  const validated = await validatePrivateInvocationReceipt(
    rawPrivateReceipt,
    request,
    command,
    configuration.invokerVersionId,
  );
  const completedAtMs = runtimeNow(runtime);
  if (
    completedAtMs < startedAtMs
    || validated.startedAtSeconds < issuedAt - CLOCK_SKEW_SECONDS
    || validated.completedAtSeconds
      > Math.floor(completedAtMs / 1000) + CLOCK_SKEW_SECONDS
  ) {
    throw operatorError("invalid_private_invocation_receipt");
  }

  const privateInvocationReceiptSha256 = await sha256Hex(
    canonicalJson(validated.receipt),
  );
  const receiptBody = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
    status: "operator_phase_invocation_completed" as const,
    environment: "staging" as const,
    campaignIdSha256: request.execution.campaignIdSha256,
    planDigestSha256: request.execution.planDigestSha256,
    phaseExecutionId: request.execution.phaseExecutionId,
    phaseOrdinal: request.execution.phase.ordinal,
    phaseId: request.execution.phase.id,
    operator: {
      serviceName: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
      versionId: configuration.operatorVersionId,
      gateName: "JSON_COMPATIBILITY_OPERATOR_ENABLED" as const,
    },
    authorization: {
      contract: JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
      approvalEnvelope: approval.envelope,
      approvalEnvelopeSha256: approval.envelopeSha256,
      approvalSubjectSha256: approval.subjectSha256,
      issuer: approval.issuer,
      audience: approval.audience,
      keyId: approval.keyId,
      signerSpkiSha256: approval.signerSpkiSha256,
      caller: approval.caller,
      issuedAt: approval.issuedAt,
      notBefore: approval.notBefore,
      expiresAt: approval.expiresAt,
    },
    request,
    requestSha256,
    commandIdSha256,
    privateTransport: {
      kind: "service-binding-rpc" as const,
      publicUrlUsed: false as const,
      cloudflareRestUsed: false as const,
      invokerBinding: "JSON_COMPATIBILITY_INVOKER_SERVICE" as const,
    },
    privateInvocationReceipt: validated.receipt,
    privateInvocationReceiptSha256,
    startedAt: wholeSecondUtc(startedAtMs),
    completedAt: wholeSecondUtc(completedAtMs),
  };
  const operatorBodySha256 = await sha256Hex(canonicalJson(receiptBody));
  const receiptSubject = { ...receiptBody, operatorBodySha256 };
  const receiptSha256 = await sha256Hex(canonicalJson(receiptSubject));
  const receipt = { ...receiptSubject, receiptSha256 };
  assertBoundedJson(
    receipt,
    MAX_OPERATOR_INVOCATION_RECEIPT_BYTES,
    "operator_receipt_too_large",
  );
  return receipt;
}

export async function deriveJsonCompatibilityOperatorCommandId(
  request: JsonCompatibilityOperatorPhaseRequestV1,
  operatorVersionId: string,
): Promise<string> {
  const versionId = token(operatorVersionId, "operator_configuration_error");
  return await sha256Hex(
    `${COMMAND_ID_DOMAIN}${canonicalJson(request)}\n${versionId}`,
  );
}

async function createInvokeCommand(
  request: JsonCompatibilityOperatorPhaseRequestV1,
  commandIdSha256: string,
  issuedAt: number,
  configuration: OperatorConfiguration,
): Promise<JsonCompatibilityInvokeCommandV1> {
  const issueIntent: JsonCompatibilityPermitIssueIntentV1 = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_INTENT_CONTRACT,
    execution: request.execution,
    executor: request.executor,
    invoker: request.invoker,
    authorizationIdSha256: commandIdSha256,
    topologyReadbackSha256: request.topologyReadbackSha256,
    beforeContextSha256: request.beforeContextSha256,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + PERMIT_WINDOW_SECONDS,
  };
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
    commandIdSha256,
    issueIntent,
  };
  let authority;
  try {
    authority = await createInvokeAuthorityEnvelope(
      configuration.secret,
      configuration.keyId,
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
        issuer: configuration.issuer,
        audience: configuration.audience,
        credentialIdSha256: configuration.credentialIdSha256,
        commandIdSha256,
        commandSubjectSha256: await sha256Hex(canonicalJson(subject)),
        issuedAt,
        expiresAt: issuedAt + HMAC_WINDOW_SECONDS,
      },
    );
  } catch {
    throw operatorError("operator_configuration_error");
  }
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
    subject,
    authority,
  };
}

async function validatePrivateInvocationReceipt(
  input: unknown,
  request: JsonCompatibilityOperatorPhaseRequestV1,
  expectedCommand: JsonCompatibilityInvokeCommandV1,
  expectedInvokerVersionId: string,
): Promise<ValidatedPrivateInvocation> {
  const code = "invalid_private_invocation_receipt" as const;
  assertBoundedJson(input, MAX_PRIVATE_INVOCATION_RECEIPT_BYTES, code);
  const value = exactRecord(input, [
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
    "invocationBodySha256",
    "receiptSha256",
  ], code);
  let command: JsonCompatibilityInvokeCommandV1;
  try {
    command = parseJsonCompatibilityInvokeCommandV1(value.command);
  } catch {
    throw operatorError(code);
  }
  if (canonicalJson(command) !== canonicalJson(expectedCommand)) {
    throw operatorError(code);
  }

  const execution = request.execution;
  const intent = command.subject.issueIntent;
  const commandSubjectSha256 = await sha256Hex(canonicalJson(command.subject));
  const commandAuthorityEnvelopeSha256 = await sha256Hex(
    canonicalJson(command.authority),
  );
  const issueIntentSha256 = await sha256Hex(canonicalJson(intent));
  const campaignBindingSha256 = await jsonCompatibilityIssuerCampaignBinding(
    intent,
  );
  const expectedAttemptIdSha256 = await sha256Hex(
    `${INVOCATION_ATTEMPT_ID_DOMAIN}${command.subject.commandIdSha256}\n${issueIntentSha256}\n${expectedInvokerVersionId}`,
  );

  const commandAuthority = exactRecord(value.commandAuthority, [
    "issuer",
    "audience",
    "keyId",
    "credentialIdSha256",
    "commandIdSha256",
    "commandSubjectSha256",
    "claimsSha256",
    "authorityEnvelopeSha256",
    "issuedAt",
    "expiresAt",
  ], code);
  const invoker = exactRecord(value.invoker, [
    "serviceName",
    "versionId",
    "gateName",
  ], code);
  const privateTransport = exactRecord(value.privateTransport, [
    "kind",
    "publicUrlUsed",
    "cloudflareRestUsed",
    "permitIssuerBinding",
    "executorBinding",
  ], code);
  const invocationAuthority = exactRecord(value.invocationAuthority, [
    "attempt",
    "completion",
  ], code);
  const attempt = exactRecord(invocationAuthority.attempt, [
    "schemaVersion",
    "contract",
    "status",
    "campaignIdSha256",
    "campaignBindingSha256",
    "planDigestSha256",
    "phaseOrdinal",
    "phaseId",
    "phaseExecutionId",
    "commandIdSha256",
    "commandSubjectSha256",
    "commandAuthorityEnvelopeSha256",
    "issueIntentSha256",
    "topologyReadbackSha256",
    "beforeContextSha256",
    "attemptIdSha256",
    "invokerVersionId",
    "startedAt",
    "oneAttemptPerPhasePersisted",
    "phaseOrderEnforced",
    "ambiguousRetryRejected",
    "receiptSha256",
  ], code);
  const completion = exactRecord(invocationAuthority.completion, [
    "schemaVersion",
    "contract",
    "status",
    "campaignIdSha256",
    "phaseOrdinal",
    "phaseExecutionId",
    "commandIdSha256",
    "attemptIdSha256",
    "permitIdSha256",
    "permitIssueReceiptSha256",
    "executorReceiptSha256",
    "invocationBodySha256",
    "completedAt",
    "attemptCompletionPersisted",
    "phaseOrderAdvanced",
    "campaignTerminal",
    "receiptSha256",
  ], code);
  const permitIssueReceipt = exactRecord(value.permitIssueReceipt, [
    "schemaVersion",
    "contract",
    "status",
    "environment",
    "campaignIdSha256",
    "phaseOrdinal",
    "phaseExecutionId",
    "issuer",
    "authority",
    "issueIntent",
    "issueIntentSha256",
    "permitEnvelope",
    "permitEnvelopeSha256",
    "issuanceAuthority",
    "receiptSha256",
  ], code);
  const executorReceipt = exactRecord(value.executorReceipt, [
    "schemaVersion",
    "contract",
    "kind",
    "environment",
    "campaignIdSha256",
    "planDigestSha256",
    "phaseExecutionId",
    "controller",
    "runtimes",
    "ring",
    "phase",
    "authorization",
    "executor",
    "transport",
    "startedAt",
    "completedAt",
    "observations",
    "transportTotals",
    "executionBoundary",
    "receiptSha256",
  ], code);

  let parsedPermitIntent: JsonCompatibilityPermitIssueIntentV1;
  let parsedPermitRequest;
  try {
    parsedPermitIntent = parseJsonCompatibilityPermitIssueIntentV1(
      permitIssueReceipt.issueIntent,
    );
    parsedPermitRequest = parseJsonCompatibilityExecutePhaseRequestV2({
      ...execution,
      authorization: permitIssueReceipt.permitEnvelope,
    });
  } catch {
    throw operatorError(code);
  }
  const executorIdentity = exactRecord(executorReceipt.executor, [
    "serviceName",
    "versionId",
    "gateName",
    "maxConcurrency",
  ], code);
  const startedAt = utcTimestamp(value.startedAt, code);
  const completedAt = utcTimestamp(value.completedAt, code);
  const startedAtSeconds = Math.floor(Date.parse(startedAt) / 1000);
  const completedAtSeconds = Math.floor(Date.parse(completedAt) / 1000);
  const invocationBodySha256 = digest(value.invocationBodySha256, code);
  const receiptSha256 = digest(value.receiptSha256, code);
  const permitIssueReceiptSha256 = await validateCanonicalReceiptDigest(
    permitIssueReceipt,
    code,
  );
  const executorReceiptSha256 = await validateCanonicalReceiptDigest(
    executorReceipt,
    code,
  );
  const attemptReceiptSha256 = await validateCanonicalReceiptDigest(
    attempt,
    code,
  );
  await validateCanonicalReceiptDigest(completion, code);
  await validateCanonicalReceiptDigest(value, code);

  const {
    invocationBodySha256: _invocationBodySha256,
    receiptSha256: _receiptSha256,
    invocationAuthority: _invocationAuthority,
    ...bodyWithoutInvocationAuthority
  } = value;
  const reconstructedBody = {
    ...bodyWithoutInvocationAuthority,
    invocationAuthority: { attempt },
  };
  const reconstructedBodySha256 = await sha256Hex(
    canonicalJson(reconstructedBody),
  );
  const expectedCompletionStatus = execution.phase.ordinal === 4
    ? "invocation_campaign_completed"
    : "invocation_phase_completed";

  if (
    literal(value.schemaVersion, 1, code) !== 1
    || literal(
      value.contract,
      PRIVATE_INVOCATION_RECEIPT_CONTRACT,
      code,
    ) !== PRIVATE_INVOCATION_RECEIPT_CONTRACT
    || literal(value.status, "private_phase_invocation_completed", code)
      !== "private_phase_invocation_completed"
    || literal(value.environment, "staging", code) !== "staging"
    || digest(value.campaignIdSha256, code) !== execution.campaignIdSha256
    || digest(value.planDigestSha256, code) !== execution.planDigestSha256
    || token(value.phaseExecutionId, code) !== execution.phaseExecutionId
    || integer(value.phaseOrdinal, 1, 4, code) !== execution.phase.ordinal
    || literal(value.phaseId, execution.phase.id, code) !== execution.phase.id
    || token(invoker.serviceName, code) !== JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || token(invoker.versionId, code) !== expectedInvokerVersionId
    || literal(
      invoker.gateName,
      "JSON_COMPATIBILITY_INVOKER_ENABLED",
      code,
    ) !== "JSON_COMPATIBILITY_INVOKER_ENABLED"
    || literal(privateTransport.kind, "service-binding-rpc", code)
      !== "service-binding-rpc"
    || literal(privateTransport.publicUrlUsed, false, code) !== false
    || literal(privateTransport.cloudflareRestUsed, false, code) !== false
    || literal(
      privateTransport.permitIssuerBinding,
      "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      code,
    ) !== "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE"
    || literal(
      privateTransport.executorBinding,
      "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
      code,
    ) !== "JSON_COMPATIBILITY_EXECUTOR_SERVICE"
    || token(commandAuthority.issuer, code) !== command.authority.claims.issuer
    || token(commandAuthority.audience, code) !== command.authority.claims.audience
    || keyId(commandAuthority.keyId, code) !== command.authority.keyId
    || digest(commandAuthority.credentialIdSha256, code)
      !== command.authority.claims.credentialIdSha256
    || digest(commandAuthority.commandIdSha256, code)
      !== command.subject.commandIdSha256
    || digest(commandAuthority.commandSubjectSha256, code)
      !== commandSubjectSha256
    || digest(commandAuthority.claimsSha256, code)
      !== command.authority.claimsSha256
    || digest(commandAuthority.authorityEnvelopeSha256, code)
      !== commandAuthorityEnvelopeSha256
    || integer(commandAuthority.issuedAt, 1, Number.MAX_SAFE_INTEGER, code)
      !== command.authority.claims.issuedAt
    || integer(commandAuthority.expiresAt, 1, Number.MAX_SAFE_INTEGER, code)
      !== command.authority.claims.expiresAt
    || intent.authorizationIdSha256 !== command.subject.commandIdSha256
    || intent.issuedAt !== intent.notBefore
    || intent.expiresAt !== intent.issuedAt + PERMIT_WINDOW_SECONDS
    || command.authority.claims.issuedAt !== intent.issuedAt
    || command.authority.claims.expiresAt
      !== intent.issuedAt + HMAC_WINDOW_SECONDS
    || startedAtSeconds < intent.issuedAt - CLOCK_SKEW_SECONDS
    || startedAtSeconds >= command.authority.claims.expiresAt
    || completedAtSeconds < startedAtSeconds
    || canonicalJson(parsedPermitIntent) !== canonicalJson(intent)
    || digest(permitIssueReceipt.issueIntentSha256, code) !== issueIntentSha256
    || digest(permitIssueReceipt.campaignIdSha256, code)
      !== execution.campaignIdSha256
    || integer(permitIssueReceipt.phaseOrdinal, 1, 4, code)
      !== execution.phase.ordinal
    || token(permitIssueReceipt.phaseExecutionId, code)
      !== execution.phaseExecutionId
    || parsedPermitRequest.authorization.subject.executor.versionId
      !== request.executor.versionId
    || token(executorReceipt.campaignIdSha256, code)
      !== execution.campaignIdSha256
    || digest(executorReceipt.planDigestSha256, code)
      !== execution.planDigestSha256
    || token(executorReceipt.phaseExecutionId, code)
      !== execution.phaseExecutionId
    || canonicalJson(executorReceipt.phase) !== canonicalJson(execution.phase)
    || token(executorIdentity.serviceName, code)
      !== JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME
    || token(executorIdentity.versionId, code) !== request.executor.versionId
    || literal(attempt.schemaVersion, 1, code) !== 1
    || literal(
      attempt.contract,
      INVOCATION_ATTEMPT_RECEIPT_CONTRACT,
      code,
    ) !== INVOCATION_ATTEMPT_RECEIPT_CONTRACT
    || literal(attempt.status, "invocation_attempt_recorded", code)
      !== "invocation_attempt_recorded"
    || digest(attempt.campaignIdSha256, code) !== execution.campaignIdSha256
    || digest(attempt.campaignBindingSha256, code) !== campaignBindingSha256
    || digest(attempt.planDigestSha256, code) !== execution.planDigestSha256
    || integer(attempt.phaseOrdinal, 1, 4, code) !== execution.phase.ordinal
    || literal(attempt.phaseId, execution.phase.id, code) !== execution.phase.id
    || token(attempt.phaseExecutionId, code) !== execution.phaseExecutionId
    || digest(attempt.commandIdSha256, code) !== command.subject.commandIdSha256
    || digest(attempt.commandSubjectSha256, code) !== commandSubjectSha256
    || digest(attempt.commandAuthorityEnvelopeSha256, code)
      !== commandAuthorityEnvelopeSha256
    || digest(attempt.issueIntentSha256, code) !== issueIntentSha256
    || digest(attempt.topologyReadbackSha256, code)
      !== request.topologyReadbackSha256
    || digest(attempt.beforeContextSha256, code)
      !== request.beforeContextSha256
    || digest(attempt.attemptIdSha256, code) !== expectedAttemptIdSha256
    || token(attempt.invokerVersionId, code) !== expectedInvokerVersionId
    || integer(attempt.startedAt, 1, Number.MAX_SAFE_INTEGER, code)
      !== startedAtSeconds
    || literal(attempt.oneAttemptPerPhasePersisted, true, code) !== true
    || literal(attempt.phaseOrderEnforced, true, code) !== true
    || literal(attempt.ambiguousRetryRejected, true, code) !== true
    || attemptReceiptSha256 !== digest(attempt.receiptSha256, code)
    || literal(completion.schemaVersion, 1, code) !== 1
    || literal(
      completion.contract,
      INVOCATION_COMPLETION_RECEIPT_CONTRACT,
      code,
    ) !== INVOCATION_COMPLETION_RECEIPT_CONTRACT
    || literal(completion.status, expectedCompletionStatus, code)
      !== expectedCompletionStatus
    || digest(completion.campaignIdSha256, code) !== execution.campaignIdSha256
    || integer(completion.phaseOrdinal, 1, 4, code) !== execution.phase.ordinal
    || token(completion.phaseExecutionId, code) !== execution.phaseExecutionId
    || digest(completion.commandIdSha256, code)
      !== command.subject.commandIdSha256
    || digest(completion.attemptIdSha256, code) !== expectedAttemptIdSha256
    || digest(completion.permitIdSha256, code)
      !== parsedPermitRequest.authorization.subject.permitIdSha256
    || digest(completion.permitIssueReceiptSha256, code)
      !== permitIssueReceiptSha256
    || digest(completion.executorReceiptSha256, code)
      !== executorReceiptSha256
    || digest(completion.invocationBodySha256, code) !== invocationBodySha256
    || integer(completion.completedAt, 1, Number.MAX_SAFE_INTEGER, code)
      !== completedAtSeconds
    || literal(completion.attemptCompletionPersisted, true, code) !== true
    || literal(completion.phaseOrderAdvanced, true, code) !== true
    || literal(
      completion.campaignTerminal,
      execution.phase.ordinal === 4,
      code,
    ) !== (execution.phase.ordinal === 4)
    || invocationBodySha256 !== reconstructedBodySha256
    || receiptSha256 !== digest(value.receiptSha256, code)
  ) {
    throw operatorError(code);
  }
  return {
    receipt: value,
    startedAt,
    completedAt,
    startedAtSeconds,
    completedAtSeconds,
  };
}

function requireOperatorEnvironment(
  env: JsonCompatibilityOperatorEnv,
): OperatorConfiguration {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_OPERATOR_ENABLED !== "true"
  ) {
    throw operatorError("operator_disabled");
  }
  const secret = env.JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET;
  const operatorVersionId = token(
    env.CF_VERSION_METADATA?.id,
    "operator_configuration_error",
  );
  const keyIdValue = keyId(
    env.JSON_COMPATIBILITY_OPERATOR_CURRENT_KID,
    "operator_configuration_error",
  );
  const credentialIdSha256 = digest(
    env.JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256,
    "operator_configuration_error",
  );
  const invokerVersionId = token(
    env.JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID,
    "operator_configuration_error",
  );
  if (
    env.JSON_COMPATIBILITY_OPERATOR_ISSUER
      !== JSON_COMPATIBILITY_OPERATOR_ISSUER
    || env.JSON_COMPATIBILITY_OPERATOR_AUDIENCE
      !== JSON_COMPATIBILITY_INVOKER_SERVICE_NAME
    || typeof secret !== "string"
    || new TextEncoder().encode(secret).byteLength < 32
    || env.JSON_COMPATIBILITY_INVOKER_SERVICE === null
    || typeof env.JSON_COMPATIBILITY_INVOKER_SERVICE !== "object"
    || typeof env.JSON_COMPATIBILITY_INVOKER_SERVICE.invokePhase !== "function"
  ) {
    throw operatorError("operator_configuration_error");
  }
  return {
    operatorVersionId,
    issuer: JSON_COMPATIBILITY_OPERATOR_ISSUER,
    audience: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    keyId: keyIdValue,
    credentialIdSha256,
    secret,
    invokerVersionId,
  };
}

async function validateCanonicalReceiptDigest(
  value: Record<string, unknown>,
  code: "invalid_private_invocation_receipt",
): Promise<string> {
  const claimed = digest(value.receiptSha256, code);
  const { receiptSha256: _receiptSha256, ...subject } = value;
  if (claimed !== await sha256Hex(canonicalJson(subject))) {
    throw operatorError(code);
  }
  return claimed;
}

function exactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  code: JsonCompatibilityOperatorError["code"],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw operatorError(code);
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw operatorError(code);
  }
  return value;
}

function literal<const T>(
  value: unknown,
  expected: T,
  code: JsonCompatibilityOperatorError["code"],
): T {
  if (value !== expected) throw operatorError(code);
  return expected;
}

function token(
  value: unknown,
  code: JsonCompatibilityOperatorError["code"],
): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw operatorError(code);
  }
  return value;
}

function keyId(
  value: unknown,
  code: JsonCompatibilityOperatorError["code"],
): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) {
    throw operatorError(code);
  }
  return value;
}

function digest(
  value: unknown,
  code: JsonCompatibilityOperatorError["code"],
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw operatorError(code);
  }
  return value;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  code: JsonCompatibilityOperatorError["code"],
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw operatorError(code);
  }
  return value;
}

function utcTimestamp(
  value: unknown,
  code: JsonCompatibilityOperatorError["code"],
): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw operatorError(code);
  }
  return value;
}

function runtimeNow(runtime: JsonCompatibilityOperatorRuntime): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value) || value < 1) {
    throw operatorError("operator_configuration_error");
  }
  return value;
}

function wholeSecondUtc(milliseconds: number): string {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");
}

function hasKnownInvokerRejection(error: unknown): boolean {
  if (
    error === null
    || typeof error !== "object"
    || !("code" in error)
    || typeof error.code !== "string"
  ) {
    return false;
  }
  return new Set([
    "invoker_disabled",
    "invoker_configuration_error",
    "invocation_authority_conflict",
    "invocation_authority_unavailable",
    "permit_issuer_rejected",
    "permit_issuer_unavailable",
    "invalid_permit_issue_receipt",
    "executor_rejected",
    "executor_unavailable",
    "invalid_executor_receipt",
  ]).has(error.code);
}

function assertBoundedJson(
  input: unknown,
  maximumBytes: number,
  code: JsonCompatibilityOperatorError["code"],
): void {
  const encoder = new TextEncoder();
  const stack: Array<{
    readonly value: unknown;
    readonly depth: number;
    readonly exit?: boolean;
  }> = [
    { value: input, depth: 0 },
  ];
  const ancestors = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  const add = (value: number): void => {
    bytes += value;
    if (bytes > maximumBytes) throw operatorError(code);
  };
  const addString = (value: string): void => {
    if (value.length > maximumBytes) throw operatorError(code);
    add(encoder.encode(JSON.stringify(value)).byteLength);
  };

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) throw operatorError(code);
    if (current.exit) {
      if (typeof current.value === "object" && current.value !== null) {
        ancestors.delete(current.value);
      }
      continue;
    }
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw operatorError(code);
    }
    const value = current.value;
    if (value === null) {
      add(4);
    } else if (typeof value === "string") {
      addString(value);
    } else if (typeof value === "boolean") {
      add(value ? 4 : 5);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      add(String(value).length);
    } else if (typeof value === "object") {
      if (ancestors.has(value)) throw operatorError(code);
      ancestors.add(value);
      stack.push({ value, depth: current.depth, exit: true });
      if (Array.isArray(value)) {
        add(2 + Math.max(0, value.length - 1));
        for (const child of value) {
          stack.push({ value: child, depth: current.depth + 1 });
        }
      } else {
        const entries = Object.entries(value as Record<string, unknown>);
        add(2 + Math.max(0, entries.length - 1));
        for (const [key, child] of entries) {
          addString(key);
          add(1);
          stack.push({ value: child, depth: current.depth + 1 });
        }
      }
    } else {
      throw operatorError(code);
    }
  }
}

function operatorError(
  code: JsonCompatibilityOperatorError["code"],
): JsonCompatibilityOperatorError {
  return new JsonCompatibilityOperatorError(code);
}
