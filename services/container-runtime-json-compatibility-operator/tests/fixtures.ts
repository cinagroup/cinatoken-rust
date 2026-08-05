import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
  JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
  JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
  jsonCompatibilityIssuerCampaignBinding,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";
import {
  JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
  JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
  JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_INVOCATION_STATUS_QUERY_CONTRACT,
  createInvokeAuthorityEnvelope,
  parseJsonCompatibilityInvocationStatusQueryV1,
  parseJsonCompatibilityInvokeCommandV1,
  type JsonCompatibilityInvocationStatusQueryV1,
} from "../../container-runtime-json-compatibility-invoker/src/authorization";
import {
  JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
  JSON_COMPATIBILITY_RUNNER_ENTRYPOINT,
  JSON_COMPATIBILITY_RUNNER_SERVICE_NAME,
  type JsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  type JsonCompatibilityOperatorPhaseRequestV1,
} from "../src/protocol";
import {
  COMMAND_ID_DOMAIN,
  JSON_COMPATIBILITY_OPERATOR_ISSUER,
  type JsonCompatibilityOperatorEnv,
  type JsonCompatibilityOperatorRuntime,
} from "../src/operator";
import {
  JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
  operatorApprovalSigningPayload,
} from "../src/authorization";

export const NOW_MS = Date.parse("2026-08-04T08:00:00Z");
export const NOW_SECONDS = Math.floor(NOW_MS / 1000);
export const OPERATOR_VERSION_ID = "operator-version-001";
export const INVOKER_VERSION_ID = "invoker-version-001";
export const EXECUTOR_VERSION_ID = "executor-version-001";
export const OPERATOR_KEY_ID = "json-campaign-operator-current-2026-08";
export const OPERATOR_CREDENTIAL_ID_SHA256 = "b1".repeat(32);
export const OPERATOR_SECRET =
  "json-compatibility-operator-secret-32-byte-minimum";
export const OPERATOR_STATUS_KEY_ID =
  "json-campaign-status-operator-current-2026-08";
export const OPERATOR_STATUS_CREDENTIAL_ID_SHA256 = "b3".repeat(32);
export const OPERATOR_STATUS_SECRET =
  "json-compatibility-status-operator-secret-minimum";
export const OPERATOR_APPROVAL_KEY_ID = "json-campaign-approval-2026-08";
export const OPERATOR_APPROVAL_SPKI_BASE64URL =
  "MCowBQYDK2VwAyEA9v8JyOln6PrPndR6_8lAUrEWIsD7_CP777cXWBor8C8";
export const OPERATOR_APPROVAL_SPKI_SHA256 =
  "471850d2dcfe546734941e2d44fde594cb3e4445900da72536ac9683f6be5d10";
const OPERATOR_APPROVAL_PKCS8_BASE64URL =
  "MC4CAQAwBQYDK2VwBCIEIM79XI3U3zwizihw3d_2C1BkrjVK11rROOfxqGj5nW5v";

const ATTEMPT_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-id-v1\n";
const PRIVATE_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1";
const INVOCATION_ATTEMPT_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-receipt-v1";
const INVOCATION_COMPLETION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-completion-receipt-v1";

export function validOperatorRequest(
  campaignIdSha256 = "11".repeat(32),
): JsonCompatibilityOperatorPhaseRequestV1 {
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_REQUEST_CONTRACT,
    execution: {
      schemaVersion: 2,
      contract: JSON_COMPATIBILITY_EXECUTE_PHASE_REQUEST_CONTRACT,
      kind: "container-runtime-json-compatibility-phase-execution",
      environment: "staging",
      campaignIdSha256,
      planDigestSha256: "22".repeat(32),
      phaseExecutionId: "json-compat-baseline-n-minus-one-001",
      controller: {
        serviceName: "cinatoken-container-controller-staging",
        versionId: "controller-version-001",
        configSha256: "33".repeat(32),
      },
      runtimes: {
        n: {
          buildIdSha256: "44".repeat(32),
          imageDigest: `sha256:${"55".repeat(32)}`,
        },
        nMinusOne: {
          buildIdSha256: "66".repeat(32),
          imageDigest: `sha256:${"77".repeat(32)}`,
        },
      },
      ring: { generation: 9, shardCount: 8, candidateShardIndex: 3 },
      phase: {
        ordinal: 1,
        id: "baseline-n-minus-one",
        topology: { defaultRuntime: "n-minus-one", overrides: [] },
      },
    },
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: EXECUTOR_VERSION_ID,
    },
    invoker: {
      serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      versionId: INVOKER_VERSION_ID,
    },
    topologyReadbackSha256: "88".repeat(32),
    beforeContextSha256: "99".repeat(32),
  };
}

export async function validAuthorizedOperatorRequest(
  request: JsonCompatibilityOperatorPhaseRequestV1 = validOperatorRequest(),
  overrides: {
    readonly issuedAt?: number;
    readonly keyId?: string;
    readonly callerVersionId?: string;
    readonly callerConfigSha256?: string;
  } = {},
): Promise<JsonCompatibilityOperatorAuthorizedPhaseRequestV1> {
  const issuedAt = overrides.issuedAt ?? NOW_SECONDS;
  const requestSha256 = await sha256Hex(canonicalJson(request));
  const commandIdSha256 = await sha256Hex(
    `${COMMAND_ID_DOMAIN}${canonicalJson(request)}\n${OPERATOR_VERSION_ID}`,
  );
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
    environment: "staging" as const,
    issuer: JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
    audience: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
    keyId: overrides.keyId ?? OPERATOR_APPROVAL_KEY_ID,
    operator: {
      serviceName: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
      versionId: OPERATOR_VERSION_ID,
    },
    caller: {
      serviceName: JSON_COMPATIBILITY_RUNNER_SERVICE_NAME,
      entrypoint: JSON_COMPATIBILITY_RUNNER_ENTRYPOINT,
      versionId: overrides.callerVersionId ?? "runner-version-001",
      configSha256: overrides.callerConfigSha256 ?? "c1".repeat(32),
      gateName: "JSON_COMPATIBILITY_RUNNER_ENABLED" as const,
      privateRpcOnly: true as const,
    },
    campaignIdSha256: request.execution.campaignIdSha256,
    planDigestSha256: request.execution.planDigestSha256,
    phaseExecutionId: request.execution.phaseExecutionId,
    phaseOrdinal: request.execution.phase.ordinal,
    phaseId: request.execution.phase.id,
    requestSha256,
    commandIdSha256,
    topologyReadbackSha256: request.topologyReadbackSha256,
    beforeContextSha256: request.beforeContextSha256,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + 600,
  };
  const unsignedEnvelope = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
    algorithm: "Ed25519" as const,
    subject,
    subjectSha256: await sha256Hex(canonicalJson(subject)),
    signerSpkiBase64url: OPERATOR_APPROVAL_SPKI_BASE64URL,
  };
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeBase64url(OPERATOR_APPROVAL_PKCS8_BASE64URL),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    operatorApprovalSigningPayload({ subject }),
  );
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_OPERATOR_AUTHORIZED_PHASE_REQUEST_CONTRACT,
    request,
    approval: {
      ...unsignedEnvelope,
      signatureBase64url: encodeBase64url(new Uint8Array(signature)),
    },
  };
}

export function operatorEnv(
  invokePhase: (input: unknown) => Promise<unknown>,
  enabled = true,
  getPhaseStatus: (input: unknown) => Promise<unknown> = async () => {
    throw new Error("status binding not configured in this fixture");
  },
): JsonCompatibilityOperatorEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_OPERATOR_ENABLED: enabled ? "true" : "false",
    JSON_COMPATIBILITY_OPERATOR_STATUS_READ_ENABLED: "true",
    JSON_COMPATIBILITY_OPERATOR_ISSUER: JSON_COMPATIBILITY_OPERATOR_ISSUER,
    JSON_COMPATIBILITY_OPERATOR_AUDIENCE:
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER:
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_ISSUER,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_AUDIENCE:
      JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID:
      OPERATOR_APPROVAL_KEY_ID,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256:
      OPERATOR_APPROVAL_SPKI_SHA256,
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256: "",
    JSON_COMPATIBILITY_OPERATOR_CURRENT_KID: OPERATOR_KEY_ID,
    JSON_COMPATIBILITY_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
      OPERATOR_CREDENTIAL_ID_SHA256,
    JSON_COMPATIBILITY_OPERATOR_STATUS_ISSUER:
      "cinatoken-json-compatibility-campaign-operator-status-staging",
    JSON_COMPATIBILITY_OPERATOR_STATUS_AUDIENCE:
      JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
    JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_KID: OPERATOR_STATUS_KEY_ID,
    JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_CREDENTIAL_ID_SHA256:
      OPERATOR_STATUS_CREDENTIAL_ID_SHA256,
    JSON_COMPATIBILITY_OPERATOR_INVOKER_VERSION_ID: INVOKER_VERSION_ID,
    JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET: OPERATOR_SECRET,
    JSON_COMPATIBILITY_OPERATOR_STATUS_CURRENT_SECRET: OPERATOR_STATUS_SECRET,
    CF_VERSION_METADATA: { id: OPERATOR_VERSION_ID },
    JSON_COMPATIBILITY_INVOKER_SERVICE: { invokePhase, getPhaseStatus },
  };
}

function decodeBase64url(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function encodeBase64url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function runtimeSequence(
  ...timestamps: readonly number[]
): JsonCompatibilityOperatorRuntime {
  let index = 0;
  return {
    now(): number {
      const value = timestamps[Math.min(index, timestamps.length - 1)];
      index += 1;
      if (value === undefined) throw new Error("missing runtime timestamp");
      return value;
    },
  };
}

export async function validPrivateInvocationReceipt(
  commandInput: unknown,
  clockOffsetSeconds = 0,
): Promise<Record<string, unknown>> {
  const command = parseJsonCompatibilityInvokeCommandV1(commandInput);
  const intent = command.subject.issueIntent;
  const privateNowSeconds = NOW_SECONDS + clockOffsetSeconds;
  const execution = intent.execution;
  const commandSubjectSha256 = await sha256Hex(canonicalJson(command.subject));
  const authorityEnvelopeSha256 = await sha256Hex(
    canonicalJson(command.authority),
  );
  const issueIntentSha256 = await sha256Hex(canonicalJson(intent));
  const campaignBindingSha256 = await jsonCompatibilityIssuerCampaignBinding(
    intent,
  );
  const attemptIdSha256 = await sha256Hex(
    `${ATTEMPT_ID_DOMAIN}${command.subject.commandIdSha256}\n${issueIntentSha256}\n${INVOKER_VERSION_ID}`,
  );
  const permitIdSha256 = "aa".repeat(32);
  const permitSubject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_SUBJECT_CONTRACT,
    issuer: "cinatoken-json-compatibility-permit-issuer-staging",
    audience: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
    keyId: "json-permit-signing-2026-08",
    permitIdSha256,
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseExecutionId: execution.phaseExecutionId,
    controller: execution.controller,
    executor: intent.executor,
    runtimes: execution.runtimes,
    ring: execution.ring,
    phase: execution.phase,
    issuedAt: intent.issuedAt,
    notBefore: intent.notBefore,
    expiresAt: intent.expiresAt,
  };
  const permitEnvelope = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_PHASE_PERMIT_ENVELOPE_CONTRACT,
    algorithm: "Ed25519" as const,
    subject: permitSubject,
    subjectSha256: await sha256Hex(canonicalJson(permitSubject)),
    signatureBase64url: "A".repeat(86),
  };
  const permitIssueReceipt = await withReceiptDigest({
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_PERMIT_ISSUE_RECEIPT_CONTRACT,
    status: "phase_permit_issued",
    environment: "staging",
    campaignIdSha256: execution.campaignIdSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseExecutionId: execution.phaseExecutionId,
    issuer: {
      serviceName: JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
      versionId: "permit-issuer-version-001",
      keyId: permitSubject.keyId,
      signerSpkiSha256: "ab".repeat(32),
    },
    authority: {
      issuer: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      audience: JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE_NAME,
      keyId: "issuer-hmac-key-001",
      credentialIdSha256: "ac".repeat(32),
      requestIdSha256: "ad".repeat(32),
      claimsSha256: "ae".repeat(32),
    },
    issueIntent: intent,
    issueIntentSha256,
    permitEnvelope,
    permitEnvelopeSha256: await sha256Hex(canonicalJson(permitEnvelope)),
    issuanceAuthority: { fixture: "bounded-private-rpc" },
  });
  const executorReceipt = await withReceiptDigest({
    schemaVersion: 2,
    contract:
      "cinatoken-container-runtime-json-compatibility-phase-probe-receipt-v2",
    kind: "container-runtime-json-compatibility-phase-probe-receipt",
    environment: "staging",
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseExecutionId: execution.phaseExecutionId,
    controller: execution.controller,
    runtimes: execution.runtimes,
    ring: execution.ring,
    phase: execution.phase,
    authorization: { permitEnvelope },
    executor: {
      serviceName: JSON_COMPATIBILITY_EXECUTOR_SERVICE_NAME,
      versionId: EXECUTOR_VERSION_ID,
      gateName: "JSON_COMPATIBILITY_EXECUTOR_ENABLED",
      maxConcurrency: 4,
    },
    transport: {
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
    },
    startedAt: wholeSecondUtc(privateNowSeconds),
    completedAt: wholeSecondUtc(privateNowSeconds + 1),
    observations: [],
    transportTotals: { privateServiceBindingRpcCount: 8 },
    executionBoundary: { cloudflareRestRequestCount: 0 },
  });
  const attempt = await withReceiptDigest({
    schemaVersion: 1,
    contract: INVOCATION_ATTEMPT_RECEIPT_CONTRACT,
    status: "invocation_attempt_recorded",
    campaignIdSha256: execution.campaignIdSha256,
    campaignBindingSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseId: execution.phase.id,
    phaseExecutionId: execution.phaseExecutionId,
    commandIdSha256: command.subject.commandIdSha256,
    commandSubjectSha256,
    commandAuthorityEnvelopeSha256: authorityEnvelopeSha256,
    issueIntentSha256,
    topologyReadbackSha256: intent.topologyReadbackSha256,
    beforeContextSha256: intent.beforeContextSha256,
    attemptIdSha256,
    invokerVersionId: INVOKER_VERSION_ID,
    startedAt: privateNowSeconds,
    oneAttemptPerPhasePersisted: true,
    phaseOrderEnforced: true,
    ambiguousRetryRejected: true,
  });
  const startedAt = wholeSecondUtc(privateNowSeconds);
  const completedAt = wholeSecondUtc(privateNowSeconds + 1);
  const receiptBody = {
    schemaVersion: 1,
    contract: PRIVATE_INVOCATION_RECEIPT_CONTRACT,
    status: "private_phase_invocation_completed",
    environment: "staging",
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    phaseExecutionId: execution.phaseExecutionId,
    phaseOrdinal: execution.phase.ordinal,
    phaseId: execution.phase.id,
    command,
    commandAuthority: {
      issuer: command.authority.claims.issuer,
      audience: command.authority.claims.audience,
      keyId: command.authority.keyId,
      credentialIdSha256: command.authority.claims.credentialIdSha256,
      commandIdSha256: command.subject.commandIdSha256,
      commandSubjectSha256,
      claimsSha256: command.authority.claimsSha256,
      authorityEnvelopeSha256,
      issuedAt: command.authority.claims.issuedAt,
      expiresAt: command.authority.claims.expiresAt,
    },
    invoker: {
      serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      versionId: INVOKER_VERSION_ID,
      gateName: "JSON_COMPATIBILITY_INVOKER_ENABLED",
    },
    privateTransport: {
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
      permitIssuerBinding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      executorBinding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
    },
    invocationAuthority: { attempt },
    permitIssueReceipt,
    executorReceipt,
    startedAt,
    completedAt,
  };
  const invocationBodySha256 = await sha256Hex(canonicalJson(receiptBody));
  const completion = await withReceiptDigest({
    schemaVersion: 1,
    contract: INVOCATION_COMPLETION_RECEIPT_CONTRACT,
    status: "invocation_phase_completed",
    campaignIdSha256: execution.campaignIdSha256,
    phaseOrdinal: execution.phase.ordinal,
    phaseExecutionId: execution.phaseExecutionId,
    commandIdSha256: command.subject.commandIdSha256,
    attemptIdSha256,
    permitIdSha256,
    permitIssueReceiptSha256: permitIssueReceipt.receiptSha256,
    executorReceiptSha256: executorReceipt.receiptSha256,
    invocationBodySha256,
    completedAt: privateNowSeconds + 1,
    attemptCompletionPersisted: true,
    phaseOrderAdvanced: true,
    campaignTerminal: false,
  });
  return await withReceiptDigest({
    ...receiptBody,
    invocationAuthority: { attempt, completion },
    invocationBodySha256,
  });
}

export async function validInvokeCommandForOperatorRequest(
  request: JsonCompatibilityOperatorPhaseRequestV1,
  issuedAt = NOW_SECONDS,
) {
  const commandIdSha256 = await sha256Hex(
    `${COMMAND_ID_DOMAIN}${canonicalJson(request)}\n${OPERATOR_VERSION_ID}`,
  );
  const issueIntent = {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issue-intent-v1" as const,
    execution: request.execution,
    executor: request.executor,
    invoker: request.invoker,
    authorizationIdSha256: commandIdSha256,
    topologyReadbackSha256: request.topologyReadbackSha256,
    beforeContextSha256: request.beforeContextSha256,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + 300,
  };
  const subject = {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_SUBJECT_CONTRACT,
    commandIdSha256,
    issueIntent,
  };
  return {
    schemaVersion: 1 as const,
    contract: JSON_COMPATIBILITY_INVOKE_COMMAND_CONTRACT,
    subject,
    authority: await createInvokeAuthorityEnvelope(
      OPERATOR_SECRET,
      OPERATOR_KEY_ID,
      {
        schemaVersion: 1,
        contract: JSON_COMPATIBILITY_INVOKE_AUTHORITY_CLAIMS_CONTRACT,
        issuer: JSON_COMPATIBILITY_OPERATOR_ISSUER,
        audience: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
        credentialIdSha256: OPERATOR_CREDENTIAL_ID_SHA256,
        commandIdSha256,
        commandSubjectSha256: await sha256Hex(canonicalJson(subject)),
        issuedAt,
        expiresAt: issuedAt + 60,
      },
    ),
  };
}

export async function validPrivateInvocationStatusReceipt(
  queryInput: unknown,
  privateInvocationReceipt?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const query = parseJsonCompatibilityInvocationStatusQueryV1(queryInput);
  let result: Record<string, unknown>;
  if (privateInvocationReceipt === undefined) {
    result = { status: "not_found", retryPermitted: false };
  } else {
    const invocationAuthority = record(
      privateInvocationReceipt.invocationAuthority,
    );
    result = {
      status: "completed",
      attempt: invocationAuthority.attempt,
      completion: invocationAuthority.completion,
      privateInvocationReceipt,
      privateInvocationReceiptSha256:
        await sha256Hex(canonicalJson(privateInvocationReceipt)),
      recoveredFromPersistedAuthority: true,
      retryPermitted: false,
      executionRpcRepeated: false,
    };
  }
  const claims = query.authority.claims;
  return await withReceiptDigest({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-private-invocation-status-receipt-v1",
    status: "private_invocation_status_resolved",
    environment: "staging",
    target: query.subject.target,
    query,
    queryAuthority: {
      issuer: claims.issuer,
      audience: claims.audience,
      keyId: query.authority.keyId,
      credentialIdSha256: claims.credentialIdSha256,
      statusQueryIdSha256: claims.statusQueryIdSha256,
      statusQuerySubjectSha256: await sha256Hex(canonicalJson(query.subject)),
      claimsSha256: query.authority.claimsSha256,
      authorityEnvelopeSha256: await sha256Hex(canonicalJson(query.authority)),
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    },
    invoker: {
      serviceName: JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
      versionId: INVOKER_VERSION_ID,
      gateName: "JSON_COMPATIBILITY_INVOKER_STATUS_READ_ENABLED",
    },
    privateTransport: {
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
      invocationAuthorityBinding: "JSON_COMPATIBILITY_INVOCATION_AUTHORITY",
    },
    result,
    queriedAt: wholeSecondUtc(claims.issuedAt),
  });
}

export async function detachedPrivateInvocationReceipt(
  valid: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const authority = record(valid.invocationAuthority);
  const completion = record(authority.completion);
  const {
    receiptSha256: _completionReceiptSha256,
    ...completionSubject
  } = completion;
  const detachedCompletion = await withReceiptDigest({
    ...completionSubject,
    commandIdSha256: "ff".repeat(32),
  });
  const {
    receiptSha256: _privateReceiptSha256,
    ...privateSubject
  } = valid;
  return await withReceiptDigest({
    ...privateSubject,
    invocationAuthority: {
      attempt: authority.attempt,
      completion: detachedCompletion,
    },
  });
}

export async function withReceiptDigest(
  subject: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    ...subject,
    receiptSha256: await sha256Hex(canonicalJson(subject)),
  };
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fixture value must be an object");
  }
  return value as Record<string, unknown>;
}

function wholeSecondUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}
