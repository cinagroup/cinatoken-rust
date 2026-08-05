import { createHash } from "node:crypto";

import {
  JsonCompatibilityCampaignError,
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";

export const JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-private-invocation-receipt-v1";

const INVOKER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-invoker-staging";
const ISSUER_SERVICE =
  "cinatoken-container-runtime-json-compatibility-permit-issuer-staging";
const EXECUTOR_SERVICE =
  "cinatoken-container-runtime-json-compatibility-executor-staging";
const INVOKE_COMMAND_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-command-v1";
const INVOKE_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-command-subject-v1";
const INVOKE_AUTHORITY_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-authority-envelope-v1";
const INVOKE_AUTHORITY_CLAIMS_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invoke-authority-claims-v1";
const ISSUE_INTENT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-intent-v1";
const ISSUE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issue-receipt-v1";
const ISSUANCE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1";
const ATTEMPT_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-receipt-v1";
const COMPLETION_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-invocation-completion-receipt-v1";
const ATTEMPT_ID_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-invocation-attempt-id-v1\n";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HMAC_SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const WHOLE_SECOND_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function validateJsonCompatibilityPrivateInvocationReceipt(plan, input) {
  const label = "[private-invocation] receipt";
  const value = record(input, label);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment", "campaignIdSha256",
    "planDigestSha256", "phaseExecutionId", "phaseOrdinal", "phaseId",
    "command", "commandAuthority", "invoker", "privateTransport",
    "invocationAuthority", "permitIssueReceipt", "executorReceipt",
    "startedAt", "completedAt", "invocationBodySha256", "receiptSha256",
  ], label);
  equal(value.schemaVersion, 1, `${label} schema version`);
  equal(value.contract, JSON_COMPATIBILITY_PRIVATE_INVOCATION_RECEIPT_CONTRACT, `${label} contract`);
  equal(value.status, "private_phase_invocation_completed", `${label} status`);
  equal(value.environment, "staging", `${label} environment`);
  equal(value.campaignIdSha256, plan.campaignIdSha256, `${label} campaign ID`);
  equal(value.planDigestSha256, plan.planDigestSha256, `${label} plan digest`);
  sha256(value.campaignIdSha256, `${label} campaign ID`);
  sha256(value.planDigestSha256, `${label} plan digest`);
  safeToken(value.phaseExecutionId, `${label} phase execution ID`);
  const phaseOrdinal = integer(value.phaseOrdinal, 1, 4, `${label} phase ordinal`);
  const expectedPhase = plan.phases[phaseOrdinal - 1];
  equal(value.phaseId, expectedPhase?.id, `${label} phase ID`);
  const startedAt = wholeSecond(value.startedAt, `${label} start`);
  const completedAt = wholeSecond(value.completedAt, `${label} completion`);
  if (completedAt < startedAt) failure(`${label} completion precedes start`);

  const command = validateCommand(value.command, value, label);
  const commandAuthority = validateVerifiedCommandAuthority(
    value.commandAuthority,
    command,
    label,
  );
  bindCommandAuthorityToPlan(commandAuthority, plan, label);
  const invoker = validateInvoker(value.invoker, label);
  const privateTransport = validatePrivateTransport(value.privateTransport, label);
  const invocationAuthority = validateInvocationAuthority(
    value.invocationAuthority,
    value,
    command,
    commandAuthority,
    invoker,
    label,
  );
  const permitIssueReceipt = validatePermitIssueReceipt(
    value.permitIssueReceipt,
    value,
    command.subject.issueIntent,
    label,
  );

  sha256(value.invocationBodySha256, `${label} body digest`);
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
    command: value.command,
    commandAuthority: value.commandAuthority,
    invoker: value.invoker,
    privateTransport: value.privateTransport,
    invocationAuthority: { attempt: value.invocationAuthority.attempt },
    permitIssueReceipt: value.permitIssueReceipt,
    executorReceipt: value.executorReceipt,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  };
  equal(
    value.invocationBodySha256,
    sha256Canonical(receiptBody),
    `${label} body digest`,
  );
  const { receiptSha256, ...receiptSubject } = value;
  equal(receiptSha256, sha256Canonical(receiptSubject), `${label} canonical digest`);
  validateCompletionBinding(
    invocationAuthority.completion,
    value,
    command,
    permitIssueReceipt,
    label,
  );
  return value;
}

export function bindJsonCompatibilityPrivateInvocationToExecutor(
  plan,
  invocation,
  executorReceipt,
) {
  const label = "[private-invocation] executor binding";
  const intent = invocation.command.subject.issueIntent;
  const execution = intent.execution;
  const expectedExecution = {
    schemaVersion: 2,
    contract:
      "cinatoken-container-runtime-json-compatibility-execute-phase-request-v2",
    kind: "container-runtime-json-compatibility-phase-execution",
    environment: "staging",
    campaignIdSha256: executorReceipt.campaignIdSha256,
    planDigestSha256: executorReceipt.planDigestSha256,
    phaseExecutionId: executorReceipt.phaseExecutionId,
    controller: executorReceipt.controller,
    runtimes: executorReceipt.runtimes,
    ring: executorReceipt.ring,
    phase: executorReceipt.phase,
  };
  canonicalEqual(execution, expectedExecution, `${label} execution intent`);
  equal(intent.executor.serviceName, EXECUTOR_SERVICE, `${label} executor service`);
  equal(intent.executor.versionId, executorReceipt.executor.versionId, `${label} executor version`);
  equal(intent.invoker.serviceName, INVOKER_SERVICE, `${label} invoker service`);
  equal(intent.invoker.versionId, invocation.invoker.versionId, `${label} invoker version`);
  equal(invocation.campaignIdSha256, executorReceipt.campaignIdSha256, `${label} campaign ID`);
  equal(invocation.planDigestSha256, executorReceipt.planDigestSha256, `${label} plan digest`);
  equal(invocation.phaseExecutionId, executorReceipt.phaseExecutionId, `${label} phase execution ID`);
  equal(invocation.phaseOrdinal, executorReceipt.phase.ordinal, `${label} phase ordinal`);
  equal(invocation.phaseId, executorReceipt.phase.id, `${label} phase ID`);
  equal(
    invocation.permitIssueReceipt.permitEnvelopeSha256,
    sha256Canonical(executorReceipt.authorization.permitEnvelope),
    `${label} permit envelope digest`,
  );
  canonicalEqual(
    invocation.permitIssueReceipt.permitEnvelope,
    executorReceipt.authorization.permitEnvelope,
    `${label} permit envelope`,
  );
  equal(
    invocation.permitIssueReceipt.receiptSha256,
    invocation.invocationAuthority.completion.permitIssueReceiptSha256,
    `${label} issuer receipt completion binding`,
  );
  equal(
    executorReceipt.receiptSha256,
    invocation.invocationAuthority.completion.executorReceiptSha256,
    `${label} executor completion binding`,
  );
  equal(
    invocation.permitIssueReceipt.issuer.versionId,
    invocation.permitIssueReceipt.issuanceAuthority.issuerVersionId,
    `${label} issuer version`,
  );
  equal(plan.campaignIdSha256, invocation.campaignIdSha256, `${label} plan campaign`);

  return {
    contract: invocation.contract,
    receiptSha256: invocation.receiptSha256,
    rawReceiptSha256: sha256Canonical(invocation),
    invocationBodySha256: invocation.invocationBodySha256,
    phaseExecutionId: invocation.phaseExecutionId,
    phaseOrdinal: invocation.phaseOrdinal,
    phaseId: invocation.phaseId,
    commandIdSha256: invocation.command.subject.commandIdSha256,
    operatorAuthority: {
      issuer: invocation.commandAuthority.issuer,
      audience: invocation.commandAuthority.audience,
      keyId: invocation.commandAuthority.keyId,
      credentialIdSha256: invocation.commandAuthority.credentialIdSha256,
      claimsSha256: invocation.commandAuthority.claimsSha256,
      commandSubjectSha256: invocation.commandAuthority.commandSubjectSha256,
      authorityEnvelopeSha256:
        invocation.commandAuthority.authorityEnvelopeSha256,
      issuedAt: invocation.commandAuthority.issuedAt,
      expiresAt: invocation.commandAuthority.expiresAt,
    },
    invoker: structuredClone(invocation.invoker),
    privateTransport: structuredClone(invocation.privateTransport),
    invocationAuthority: {
      attemptIdSha256: invocation.invocationAuthority.attempt.attemptIdSha256,
      attemptReceiptSha256:
        invocation.invocationAuthority.attempt.receiptSha256,
      completionReceiptSha256:
        invocation.invocationAuthority.completion.receiptSha256,
      oneAttemptPerPhasePersisted:
        invocation.invocationAuthority.attempt.oneAttemptPerPhasePersisted,
      phaseOrderEnforced:
        invocation.invocationAuthority.attempt.phaseOrderEnforced,
      ambiguousRetryRejected:
        invocation.invocationAuthority.attempt.ambiguousRetryRejected,
      attemptCompletionPersisted:
        invocation.invocationAuthority.completion.attemptCompletionPersisted,
      phaseOrderAdvanced:
        invocation.invocationAuthority.completion.phaseOrderAdvanced,
      campaignTerminal:
        invocation.invocationAuthority.completion.campaignTerminal,
    },
    permitIssue: {
      contract: invocation.permitIssueReceipt.contract,
      receiptSha256: invocation.permitIssueReceipt.receiptSha256,
      issueIntentSha256: invocation.permitIssueReceipt.issueIntentSha256,
      permitEnvelopeSha256:
        invocation.permitIssueReceipt.permitEnvelopeSha256,
      issuanceAuthorityReceiptSha256:
        invocation.permitIssueReceipt.issuanceAuthority.receiptSha256,
      issuer: structuredClone(invocation.permitIssueReceipt.issuer),
      authority: structuredClone(invocation.permitIssueReceipt.authority),
    },
    executorReceiptSha256: executorReceipt.receiptSha256,
    startedAt: invocation.startedAt,
    completedAt: invocation.completedAt,
  };
}

function validateCommand(input, invocation, label) {
  const value = record(input, `${label} command`);
  exactKeys(value, ["schemaVersion", "contract", "subject", "authority"], `${label} command`);
  equal(value.schemaVersion, 1, `${label} command schema`);
  equal(value.contract, INVOKE_COMMAND_CONTRACT, `${label} command contract`);
  const subject = record(value.subject, `${label} command subject`);
  exactKeys(subject, ["schemaVersion", "contract", "commandIdSha256", "issueIntent"], `${label} command subject`);
  equal(subject.schemaVersion, 1, `${label} command subject schema`);
  equal(subject.contract, INVOKE_SUBJECT_CONTRACT, `${label} command subject contract`);
  sha256(subject.commandIdSha256, `${label} command ID`);
  const intent = validateIssueIntent(subject.issueIntent, invocation, label);
  equal(intent.authorizationIdSha256, subject.commandIdSha256, `${label} authorization ID`);
  const authority = validateCommandAuthorityEnvelope(value.authority, subject, label);
  return { ...value, subject: { ...subject, issueIntent: intent }, authority };
}

function validateIssueIntent(input, invocation, label) {
  const value = record(input, `${label} issue intent`);
  exactKeys(value, [
    "schemaVersion", "contract", "execution", "executor", "invoker",
    "authorizationIdSha256", "topologyReadbackSha256", "beforeContextSha256",
    "issuedAt", "notBefore", "expiresAt",
  ], `${label} issue intent`);
  equal(value.schemaVersion, 1, `${label} issue intent schema`);
  equal(value.contract, ISSUE_INTENT_CONTRACT, `${label} issue intent contract`);
  record(value.execution, `${label} execution intent`);
  const executor = record(value.executor, `${label} executor intent`);
  exactKeys(executor, ["serviceName", "versionId"], `${label} executor intent`);
  equal(executor.serviceName, EXECUTOR_SERVICE, `${label} executor service`);
  safeToken(executor.versionId, `${label} executor version`);
  const invoker = record(value.invoker, `${label} invoker intent`);
  exactKeys(invoker, ["serviceName", "versionId"], `${label} invoker intent`);
  equal(invoker.serviceName, INVOKER_SERVICE, `${label} invoker service`);
  safeToken(invoker.versionId, `${label} invoker version`);
  for (const name of ["authorizationIdSha256", "topologyReadbackSha256", "beforeContextSha256"]) {
    sha256(value[name], `${label} ${name}`);
  }
  for (const name of ["issuedAt", "notBefore", "expiresAt"]) {
    integer(value[name], 1, Number.MAX_SAFE_INTEGER, `${label} ${name}`);
  }
  if (
    value.notBefore < value.issuedAt - 5
    || value.expiresAt <= value.notBefore
    || value.expiresAt - value.issuedAt > 600
  ) failure(`${label} issue intent time window is invalid`);
  equal(value.execution.campaignIdSha256, invocation.campaignIdSha256, `${label} intent campaign`);
  equal(value.execution.planDigestSha256, invocation.planDigestSha256, `${label} intent plan`);
  equal(value.execution.phaseExecutionId, invocation.phaseExecutionId, `${label} intent execution ID`);
  return value;
}

function validateCommandAuthorityEnvelope(input, subject, label) {
  const value = record(input, `${label} command authority envelope`);
  exactKeys(value, [
    "schemaVersion", "contract", "algorithm", "keyId", "claims",
    "claimsSha256", "signatureBase64url",
  ], `${label} command authority envelope`);
  equal(value.schemaVersion, 1, `${label} command authority schema`);
  equal(value.contract, INVOKE_AUTHORITY_ENVELOPE_CONTRACT, `${label} command authority contract`);
  equal(value.algorithm, "HMAC-SHA-256", `${label} command authority algorithm`);
  keyId(value.keyId, `${label} command authority key ID`);
  const claims = record(value.claims, `${label} command authority claims`);
  exactKeys(claims, [
    "schemaVersion", "contract", "issuer", "audience", "credentialIdSha256",
    "commandIdSha256", "commandSubjectSha256", "issuedAt", "expiresAt",
  ], `${label} command authority claims`);
  equal(claims.schemaVersion, 1, `${label} command claims schema`);
  equal(claims.contract, INVOKE_AUTHORITY_CLAIMS_CONTRACT, `${label} command claims contract`);
  safeToken(claims.issuer, `${label} command claims issuer`);
  equal(claims.audience, INVOKER_SERVICE, `${label} command claims audience`);
  for (const name of ["credentialIdSha256", "commandIdSha256", "commandSubjectSha256"]) {
    sha256(claims[name], `${label} command claims ${name}`);
  }
  equal(claims.commandIdSha256, subject.commandIdSha256, `${label} command claims ID`);
  equal(claims.commandSubjectSha256, sha256Canonical(subject), `${label} command subject digest`);
  integer(claims.issuedAt, 1, Number.MAX_SAFE_INTEGER, `${label} command issuedAt`);
  integer(claims.expiresAt, 1, Number.MAX_SAFE_INTEGER, `${label} command expiresAt`);
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > 60) {
    failure(`${label} command authority time window is invalid`);
  }
  sha256(value.claimsSha256, `${label} command claims digest`);
  equal(value.claimsSha256, sha256Canonical(claims), `${label} command claims digest`);
  if (typeof value.signatureBase64url !== "string" || !HMAC_SIGNATURE.test(value.signatureBase64url)) {
    failure(`${label} command authority signature is invalid`);
  }
  return { ...value, claims };
}

function validateVerifiedCommandAuthority(input, command, label) {
  const value = record(input, `${label} verified command authority`);
  exactKeys(value, [
    "issuer", "audience", "keyId", "credentialIdSha256", "commandIdSha256",
    "commandSubjectSha256", "claimsSha256", "authorityEnvelopeSha256",
    "issuedAt", "expiresAt",
  ], `${label} verified command authority`);
  const claims = command.authority.claims;
  equal(value.issuer, claims.issuer, `${label} verified issuer`);
  equal(value.audience, claims.audience, `${label} verified audience`);
  equal(value.keyId, command.authority.keyId, `${label} verified key ID`);
  equal(value.credentialIdSha256, claims.credentialIdSha256, `${label} verified credential`);
  equal(value.commandIdSha256, claims.commandIdSha256, `${label} verified command ID`);
  equal(value.commandSubjectSha256, claims.commandSubjectSha256, `${label} verified command subject`);
  equal(value.claimsSha256, command.authority.claimsSha256, `${label} verified claims`);
  equal(value.authorityEnvelopeSha256, sha256Canonical(command.authority), `${label} verified envelope`);
  equal(value.issuedAt, claims.issuedAt, `${label} verified issuedAt`);
  equal(value.expiresAt, claims.expiresAt, `${label} verified expiresAt`);
  return value;
}

function bindCommandAuthorityToPlan(authority, plan, label) {
  const planned = plan.statusRecovery?.statusAuthority?.execution;
  if (planned === undefined) return;
  for (const name of ["issuer", "audience", "keyId", "credentialIdSha256"]) {
    equal(
      authority[name],
      planned[name],
      `${label} planned execution authority ${name}`,
    );
  }
}

function validateInvoker(input, label) {
  const value = record(input, `${label} invoker`);
  exactKeys(value, ["serviceName", "versionId", "gateName"], `${label} invoker`);
  equal(value.serviceName, INVOKER_SERVICE, `${label} invoker service`);
  safeToken(value.versionId, `${label} invoker version`);
  equal(value.gateName, "JSON_COMPATIBILITY_INVOKER_ENABLED", `${label} invoker gate`);
  return value;
}

function validatePrivateTransport(input, label) {
  const value = record(input, `${label} private transport`);
  exactKeys(value, [
    "kind", "publicUrlUsed", "cloudflareRestUsed", "permitIssuerBinding",
    "executorBinding",
  ], `${label} private transport`);
  equal(value.kind, "service-binding-rpc", `${label} transport kind`);
  equal(value.publicUrlUsed, false, `${label} public URL flag`);
  equal(value.cloudflareRestUsed, false, `${label} REST flag`);
  equal(value.permitIssuerBinding, "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE", `${label} issuer binding`);
  equal(value.executorBinding, "JSON_COMPATIBILITY_EXECUTOR_SERVICE", `${label} executor binding`);
  return value;
}

function validateInvocationAuthority(input, invocation, command, authority, invoker, label) {
  const value = record(input, `${label} invocation authority`);
  exactKeys(value, ["attempt", "completion"], `${label} invocation authority`);
  const attempt = record(value.attempt, `${label} attempt receipt`);
  exactKeys(attempt, [
    "schemaVersion", "contract", "status", "campaignIdSha256",
    "campaignBindingSha256", "planDigestSha256", "phaseOrdinal", "phaseId",
    "phaseExecutionId", "commandIdSha256", "commandSubjectSha256",
    "commandAuthorityEnvelopeSha256", "issueIntentSha256",
    "topologyReadbackSha256", "beforeContextSha256", "attemptIdSha256",
    "invokerVersionId", "startedAt", "oneAttemptPerPhasePersisted",
    "phaseOrderEnforced", "ambiguousRetryRejected", "receiptSha256",
  ], `${label} attempt receipt`);
  equal(attempt.schemaVersion, 1, `${label} attempt schema`);
  equal(attempt.contract, ATTEMPT_RECEIPT_CONTRACT, `${label} attempt contract`);
  equal(attempt.status, "invocation_attempt_recorded", `${label} attempt status`);
  equal(attempt.campaignIdSha256, invocation.campaignIdSha256, `${label} attempt campaign`);
  equal(attempt.planDigestSha256, invocation.planDigestSha256, `${label} attempt plan`);
  equal(attempt.phaseOrdinal, invocation.phaseOrdinal, `${label} attempt phase ordinal`);
  equal(attempt.phaseId, invocation.phaseId, `${label} attempt phase ID`);
  equal(attempt.phaseExecutionId, invocation.phaseExecutionId, `${label} attempt execution ID`);
  equal(attempt.commandIdSha256, command.subject.commandIdSha256, `${label} attempt command ID`);
  equal(attempt.commandSubjectSha256, authority.commandSubjectSha256, `${label} attempt command subject`);
  equal(attempt.commandAuthorityEnvelopeSha256, authority.authorityEnvelopeSha256, `${label} attempt envelope`);
  const intentSha256 = sha256Canonical(command.subject.issueIntent);
  equal(attempt.issueIntentSha256, intentSha256, `${label} attempt intent`);
  equal(attempt.topologyReadbackSha256, command.subject.issueIntent.topologyReadbackSha256, `${label} attempt topology readback`);
  equal(attempt.beforeContextSha256, command.subject.issueIntent.beforeContextSha256, `${label} attempt before context`);
  equal(attempt.invokerVersionId, invoker.versionId, `${label} attempt invoker version`);
  integer(attempt.startedAt, 1, Number.MAX_SAFE_INTEGER, `${label} attempt start`);
  for (const name of ["oneAttemptPerPhasePersisted", "phaseOrderEnforced", "ambiguousRetryRejected"]) {
    equal(attempt[name], true, `${label} attempt ${name}`);
  }
  sha256(attempt.campaignBindingSha256, `${label} campaign binding`);
  const expectedBinding = issuerCampaignBinding(command.subject.issueIntent);
  equal(attempt.campaignBindingSha256, expectedBinding, `${label} campaign binding`);
  const expectedAttemptId = sha256Text(
    `${ATTEMPT_ID_DOMAIN}${command.subject.commandIdSha256}\n${intentSha256}\n${invoker.versionId}`,
  );
  equal(attempt.attemptIdSha256, expectedAttemptId, `${label} attempt ID`);
  sha256(attempt.receiptSha256, `${label} attempt digest`);
  const { receiptSha256, ...attemptSubject } = attempt;
  equal(receiptSha256, sha256Canonical(attemptSubject), `${label} attempt digest`);

  const completion = record(value.completion, `${label} completion receipt`);
  exactKeys(completion, [
    "schemaVersion", "contract", "status", "campaignIdSha256", "phaseOrdinal",
    "phaseExecutionId", "commandIdSha256", "attemptIdSha256", "permitIdSha256",
    "permitIssueReceiptSha256", "executorReceiptSha256", "invocationBodySha256",
    "completedAt", "attemptCompletionPersisted", "phaseOrderAdvanced",
    "campaignTerminal", "receiptSha256",
  ], `${label} completion receipt`);
  equal(completion.schemaVersion, 1, `${label} completion schema`);
  equal(completion.contract, COMPLETION_RECEIPT_CONTRACT, `${label} completion contract`);
  equal(
    completion.status,
    invocation.phaseOrdinal === 4
      ? "invocation_campaign_completed"
      : "invocation_phase_completed",
    `${label} completion status`,
  );
  equal(completion.campaignIdSha256, invocation.campaignIdSha256, `${label} completion campaign`);
  equal(completion.phaseOrdinal, invocation.phaseOrdinal, `${label} completion phase ordinal`);
  equal(completion.phaseExecutionId, invocation.phaseExecutionId, `${label} completion execution ID`);
  equal(completion.commandIdSha256, command.subject.commandIdSha256, `${label} completion command ID`);
  equal(completion.attemptIdSha256, attempt.attemptIdSha256, `${label} completion attempt ID`);
  equal(completion.invocationBodySha256, invocation.invocationBodySha256, `${label} completion body digest`);
  integer(completion.completedAt, 1, Number.MAX_SAFE_INTEGER, `${label} completion time`);
  equal(completion.attemptCompletionPersisted, true, `${label} completion persisted`);
  equal(completion.phaseOrderAdvanced, true, `${label} phase advanced`);
  equal(completion.campaignTerminal, invocation.phaseOrdinal === 4, `${label} terminal flag`);
  for (const name of [
    "permitIdSha256", "permitIssueReceiptSha256", "executorReceiptSha256",
    "invocationBodySha256", "receiptSha256",
  ]) sha256(completion[name], `${label} completion ${name}`);
  const { receiptSha256: completionSha256, ...completionSubject } = completion;
  equal(completionSha256, sha256Canonical(completionSubject), `${label} completion digest`);
  return { attempt, completion };
}

function validatePermitIssueReceipt(input, invocation, intent, label) {
  const value = record(input, `${label} permit issue receipt`);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "environment", "campaignIdSha256",
    "phaseOrdinal", "phaseExecutionId", "issuer", "authority", "issueIntent",
    "issueIntentSha256", "permitEnvelope", "permitEnvelopeSha256",
    "issuanceAuthority", "receiptSha256",
  ], `${label} permit issue receipt`);
  equal(value.schemaVersion, 1, `${label} issuer receipt schema`);
  equal(value.contract, ISSUE_RECEIPT_CONTRACT, `${label} issuer receipt contract`);
  equal(value.status, "phase_permit_issued", `${label} issuer receipt status`);
  equal(value.environment, "staging", `${label} issuer receipt environment`);
  equal(value.campaignIdSha256, invocation.campaignIdSha256, `${label} issuer campaign`);
  equal(value.phaseOrdinal, invocation.phaseOrdinal, `${label} issuer phase ordinal`);
  equal(value.phaseExecutionId, invocation.phaseExecutionId, `${label} issuer execution ID`);
  const issuer = record(value.issuer, `${label} issuer identity`);
  exactKeys(issuer, ["serviceName", "versionId", "keyId", "signerSpkiSha256"], `${label} issuer identity`);
  equal(issuer.serviceName, ISSUER_SERVICE, `${label} issuer service`);
  safeToken(issuer.versionId, `${label} issuer version`);
  keyId(issuer.keyId, `${label} permit key ID`);
  sha256(issuer.signerSpkiSha256, `${label} signer SPKI digest`);
  const authority = record(value.authority, `${label} issuer authority`);
  exactKeys(authority, [
    "issuer", "audience", "keyId", "credentialIdSha256", "requestIdSha256",
    "claimsSha256",
  ], `${label} issuer authority`);
  equal(authority.issuer, INVOKER_SERVICE, `${label} issuer authority issuer`);
  equal(authority.audience, ISSUER_SERVICE, `${label} issuer authority audience`);
  keyId(authority.keyId, `${label} issuer authority key ID`);
  for (const name of ["credentialIdSha256", "requestIdSha256", "claimsSha256"]) {
    sha256(authority[name], `${label} issuer authority ${name}`);
  }
  canonicalEqual(value.issueIntent, intent, `${label} issue intent`);
  sha256(value.issueIntentSha256, `${label} issue intent digest`);
  equal(value.issueIntentSha256, sha256Canonical(intent), `${label} issue intent digest`);
  record(value.permitEnvelope, `${label} permit envelope`);
  sha256(value.permitEnvelopeSha256, `${label} permit envelope digest`);
  equal(value.permitEnvelopeSha256, sha256Canonical(value.permitEnvelope), `${label} permit envelope digest`);
  const issuance = validateIssuanceReceipt(value.issuanceAuthority, value, intent, label);
  sha256(value.receiptSha256, `${label} issuer receipt digest`);
  const { receiptSha256, ...receiptSubject } = value;
  equal(receiptSha256, sha256Canonical(receiptSubject), `${label} issuer receipt digest`);
  return { ...value, issuer, authority, issuanceAuthority: issuance };
}

function validateIssuanceReceipt(input, issueReceipt, intent, label) {
  const value = record(input, `${label} issuance authority receipt`);
  exactKeys(value, [
    "schemaVersion", "contract", "status", "campaignIdSha256",
    "campaignBindingSha256", "planDigestSha256", "phaseOrdinal", "phaseId",
    "phaseExecutionId", "issueIntentSha256", "authorityRequestIdSha256",
    "permitIdSha256", "permitSubjectSha256", "permitEnvelopeSha256",
    "issuerVersionId", "issuedAt", "expiresAt", "onePermitPerPhasePersisted",
    "phaseIssuanceOrderEnforced", "ambiguousRetryRejected", "receiptSha256",
  ], `${label} issuance authority receipt`);
  equal(value.schemaVersion, 1, `${label} issuance schema`);
  equal(value.contract, ISSUANCE_RECEIPT_CONTRACT, `${label} issuance contract`);
  equal(value.status, "permit_issuance_recorded", `${label} issuance status`);
  const execution = intent.execution;
  equal(value.campaignIdSha256, execution.campaignIdSha256, `${label} issuance campaign`);
  equal(value.campaignBindingSha256, issuerCampaignBinding(intent), `${label} issuance binding`);
  equal(value.planDigestSha256, execution.planDigestSha256, `${label} issuance plan`);
  equal(value.phaseOrdinal, execution.phase.ordinal, `${label} issuance phase ordinal`);
  equal(value.phaseId, execution.phase.id, `${label} issuance phase ID`);
  equal(value.phaseExecutionId, execution.phaseExecutionId, `${label} issuance execution ID`);
  equal(value.issueIntentSha256, issueReceipt.issueIntentSha256, `${label} issuance intent`);
  equal(value.authorityRequestIdSha256, issueReceipt.authority.requestIdSha256, `${label} issuance request`);
  equal(value.permitIdSha256, issueReceipt.permitEnvelope.subject?.permitIdSha256, `${label} issuance permit ID`);
  equal(value.permitSubjectSha256, issueReceipt.permitEnvelope.subjectSha256, `${label} issuance permit subject`);
  equal(value.permitEnvelopeSha256, issueReceipt.permitEnvelopeSha256, `${label} issuance envelope`);
  equal(value.issuerVersionId, issueReceipt.issuer.versionId, `${label} issuance version`);
  equal(value.issuedAt, intent.issuedAt, `${label} issuance time`);
  equal(value.expiresAt, intent.expiresAt, `${label} issuance expiry`);
  for (const name of ["onePermitPerPhasePersisted", "phaseIssuanceOrderEnforced", "ambiguousRetryRejected"]) {
    equal(value[name], true, `${label} issuance ${name}`);
  }
  sha256(value.receiptSha256, `${label} issuance digest`);
  const { receiptSha256, ...receiptSubject } = value;
  equal(receiptSha256, sha256Canonical(receiptSubject), `${label} issuance digest`);
  return value;
}

function validateCompletionBinding(completion, invocation, command, permitReceipt, label) {
  equal(completion.permitIdSha256, permitReceipt.permitEnvelope.subject.permitIdSha256, `${label} completion permit`);
  equal(completion.permitIssueReceiptSha256, permitReceipt.receiptSha256, `${label} completion issuer receipt`);
  equal(completion.executorReceiptSha256, invocation.executorReceipt.receiptSha256, `${label} completion executor receipt`);
  equal(completion.commandIdSha256, command.subject.commandIdSha256, `${label} completion command`);
}

function issuerCampaignBinding(intent) {
  const execution = intent.execution;
  return sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-issuer-campaign-binding-v1",
    environment: execution.environment,
    campaignIdSha256: execution.campaignIdSha256,
    planDigestSha256: execution.planDigestSha256,
    controller: execution.controller,
    executor: intent.executor,
    invoker: intent.invoker,
    runtimes: execution.runtimes,
    ring: execution.ring,
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    failure(`${label} fields must be exactly ${wanted.join(", ")}`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) failure(`${label} must equal ${String(expected)}`);
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) failure(`${label} does not match`);
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) failure(`${label} must be lowercase SHA-256 hex`);
  return value;
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) failure(`${label} must be a safe token`);
  return value;
}

function keyId(value, label) {
  if (typeof value !== "string" || !KEY_ID.test(value)) failure(`${label} must be a safe key ID`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failure(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function wholeSecond(value, label) {
  if (
    typeof value !== "string"
    || !WHOLE_SECOND_UTC.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().replace(".000Z", "Z") !== value
  ) failure(`${label} must be canonical whole-second UTC`);
  return Date.parse(value);
}

function failure(message) {
  throw new JsonCompatibilityCampaignError(message);
}
