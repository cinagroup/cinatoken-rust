import { describe, expect, test } from "bun:test";
import {
  buildJsonCompatibilityCampaignPlan,
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
  projectJsonCompatibilityCallerCompletion,
  projectJsonCompatibilityResolvedRunner,
  resolveJsonCompatibilityCallerCompletion,
  validateJsonCompatibilityCallerInvocationReceipt,
  validateJsonCompatibilityCallerStatusReceipt,
} from "../tools/container_runtime_json_compatibility_caller_invocation.mjs";
import {
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_V1_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_V1_CONTRACT,
} from "../tools/container_runtime_json_compatibility_operator_invocation.mjs";
import {
  getJsonCompatibilityOperatorPhaseStatus,
  invokeJsonCompatibilityOperatorPhase,
} from "../services/container-runtime-json-compatibility-operator/src/operator.ts";
import {
  EXECUTOR_VERSION_ID,
  INVOKER_VERSION_ID,
  NOW_MS,
  OPERATOR_APPROVAL_KEY_ID,
  OPERATOR_APPROVAL_SPKI_SHA256,
  OPERATOR_CREDENTIAL_ID_SHA256,
  OPERATOR_KEY_ID,
  OPERATOR_STATUS_CREDENTIAL_ID_SHA256,
  OPERATOR_STATUS_KEY_ID,
  OPERATOR_VERSION_ID,
  operatorEnv,
  runtimeSequence,
  validAuthorizedOperatorRequest,
  validInvokeCommandForOperatorRequest,
  validOperatorRequest,
  validPrivateInvocationReceipt,
  validPrivateInvocationStatusReceipt,
} from "../services/container-runtime-json-compatibility-operator/tests/fixtures.ts";
import {
  getJsonCompatibilityRunnerPhaseStatus,
  invokeJsonCompatibilityRunnerPhase,
} from "../services/container-runtime-json-compatibility-runner/src/runner.ts";
import {
  getJsonCompatibilityCallerPhaseStatus,
  invokeJsonCompatibilityCallerPhase,
} from "../services/container-runtime-json-compatibility-caller/src/caller.ts";
import {
  JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
} from "../services/container-runtime-json-compatibility-caller/src/protocol.ts";

const RUNNER_VERSION_ID = "runner-version-caller-test-001";
const RUNNER_CONFIG_SHA256 = "a1".repeat(32);
const CALLER_VERSION_ID = "caller-version-test-001";
const CALLER_CONFIG_SHA256 = "a2".repeat(32);
const EXPECTED_CALLER = Object.freeze({
  versionId: CALLER_VERSION_ID,
  configSha256: CALLER_CONFIG_SHA256,
});

const controllerConfig = JSON.parse(
  await Bun.file(new URL(
    "../services/container-controller/wrangler.staging.jsonc",
    import.meta.url,
  )).text(),
);
controllerConfig.vars.CONTAINER_JSON_COMPATIBILITY_PROBE_ENABLED = "true";

function buildPlan() {
  return buildJsonCompatibilityCampaignPlan({
    config: structuredClone(controllerConfig),
    campaignIdSha256: "11".repeat(32),
    deploymentStatePlanDigestSha256: "d2".repeat(32),
    controllerVersionId: "controller-version-caller-test-001",
    callerVersionId: CALLER_VERSION_ID,
    callerConfigSha256: CALLER_CONFIG_SHA256,
    runnerVersionId: RUNNER_VERSION_ID,
    runnerConfigSha256: RUNNER_CONFIG_SHA256,
    operatorVersionId: OPERATOR_VERSION_ID,
    operatorConfigSha256: "b1".repeat(32),
    operatorHmacKeyId: OPERATOR_KEY_ID,
    operatorHmacCredentialIdSha256: OPERATOR_CREDENTIAL_ID_SHA256,
    operatorStatusHmacKeyId: OPERATOR_STATUS_KEY_ID,
    operatorStatusHmacCredentialIdSha256:
      OPERATOR_STATUS_CREDENTIAL_ID_SHA256,
    operatorApprovalKeyId: OPERATOR_APPROVAL_KEY_ID,
    operatorApprovalSpkiSha256: OPERATOR_APPROVAL_SPKI_SHA256,
    invokerVersionId: INVOKER_VERSION_ID,
    invokerConfigSha256: "b2".repeat(32),
    permitIssuerVersionId: "permit-issuer-version-001",
    permitIssuerConfigSha256: "b3".repeat(32),
    executorVersionId: EXECUTOR_VERSION_ID,
    executorConfigSha256: "b4".repeat(32),
    runtimeNBuildIdSha256: "44".repeat(32),
    runtimeNImageDigest: `sha256:${"55".repeat(32)}`,
    runtimeNMinusOneBuildIdSha256: "66".repeat(32),
    runtimeNMinusOneImageDigest: `sha256:${"77".repeat(32)}`,
    candidateShardIndex: 3,
  });
}

function operatorRequestForPlan(plan) {
  const request = structuredClone(validOperatorRequest(plan.campaignIdSha256));
  const phase = plan.phases[0];
  request.execution.planDigestSha256 = plan.planDigestSha256;
  request.execution.controller = {
    serviceName: plan.controller.serviceName,
    versionId: plan.controller.versionId,
    configSha256: plan.controller.configSha256,
  };
  request.execution.runtimes = structuredClone(plan.runtimes);
  request.execution.ring = structuredClone(plan.ring);
  request.execution.phase = {
    ordinal: phase.ordinal,
    id: phase.id,
    topology: structuredClone(phase.topology),
  };
  request.executor = {
    serviceName: plan.privateServices.executor.serviceName,
    versionId: plan.privateServices.executor.versionId,
  };
  request.invoker = {
    serviceName: plan.privateServices.invoker.serviceName,
    versionId: plan.privateServices.invoker.versionId,
  };
  return request;
}

function runnerEnv(invokePhase, getPhaseStatus) {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_RUNNER_ENABLED: "true",
    JSON_COMPATIBILITY_RUNNER_STATUS_READ_ENABLED: "true",
    JSON_COMPATIBILITY_RUNNER_OPERATOR_VERSION_ID: OPERATOR_VERSION_ID,
    CF_VERSION_METADATA: { id: RUNNER_VERSION_ID },
    JSON_COMPATIBILITY_OPERATOR_SERVICE: { invokePhase, getPhaseStatus },
  };
}

function callerEnv(invokePhase, getPhaseStatus) {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_CALLER_ENABLED: "true",
    JSON_COMPATIBILITY_CALLER_STATUS_READ_ENABLED: "true",
    JSON_COMPATIBILITY_CALLER_RUNNER_VERSION_ID: RUNNER_VERSION_ID,
    JSON_COMPATIBILITY_CALLER_RUNNER_CONFIG_SHA256: RUNNER_CONFIG_SHA256,
    CF_VERSION_METADATA: { id: CALLER_VERSION_ID },
    JSON_COMPATIBILITY_RUNNER_SERVICE: { invokePhase, getPhaseStatus },
  };
}

async function invocationFixtures() {
  const plan = buildPlan();
  const request = operatorRequestForPlan(plan);
  const authorized = await validAuthorizedOperatorRequest(request, {
    callerVersionId: RUNNER_VERSION_ID,
    callerConfigSha256: RUNNER_CONFIG_SHA256,
  });
  const callerReceipt = await invokeJsonCompatibilityCallerPhase(
    callerEnv(
      async (callerInput) => await invokeJsonCompatibilityRunnerPhase(
        runnerEnv(
          async (input) => await invokeJsonCompatibilityOperatorPhase(
            operatorEnv(async (command) =>
              await currentPrivateInvocationReceipt(command)),
            input,
            runtimeSequence(NOW_MS, NOW_MS + 2_000),
          ),
          async () => {
            throw new Error("status RPC is not used by invocation fixture");
          },
        ),
        callerInput,
        runtimeSequence(NOW_MS, NOW_MS + 3_000),
      ),
      async () => {
        throw new Error("status RPC is not used by invocation fixture");
      },
    ),
    authorized,
    runtimeSequence(NOW_MS, NOW_MS + 4_000),
  );
  return {
    plan,
    authorized,
    runnerReceipt: callerReceipt.runnerReceipt,
    callerReceipt,
  };
}

async function statusFixtures() {
  const plan = buildPlan();
  const request = operatorRequestForPlan(plan);
  const authorized = await validAuthorizedOperatorRequest(request, {
    callerVersionId: RUNNER_VERSION_ID,
    callerConfigSha256: RUNNER_CONFIG_SHA256,
  });
  const command = await validInvokeCommandForOperatorRequest(request);
  const privateInvocationReceipt = await currentPrivateInvocationReceipt(command);
  const statusStart = NOW_MS + 60_000;
  const callerReceipt = await getJsonCompatibilityCallerPhaseStatus(
    callerEnv(
      async () => {
        throw new Error("execution RPC must not be retried");
      },
      async (callerInput) => await getJsonCompatibilityRunnerPhaseStatus(
        runnerEnv(
          async () => {
            throw new Error("execution RPC must not be retried");
          },
          async (input) => await getJsonCompatibilityOperatorPhaseStatus(
            operatorEnv(
              async () => {
                throw new Error("execution RPC must not be retried");
              },
              true,
              async (query) => await validPrivateInvocationStatusReceipt(
                query,
                privateInvocationReceipt,
              ),
            ),
            input,
            runtimeSequence(statusStart, statusStart + 1_000),
          ),
        ),
        callerInput,
        runtimeSequence(statusStart, statusStart + 2_000),
      ),
    ),
    {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_CALLER_PHASE_STATUS_REQUEST_CONTRACT,
      authorizedPhaseRequest: authorized,
    },
    runtimeSequence(statusStart, statusStart + 3_000),
  );
  return {
    plan,
    authorized,
    runnerReceipt: callerReceipt.runnerStatusReceipt,
    callerReceipt,
  };
}

function sealCallerReceipt(body) {
  const callerBodySha256 = sha256Canonical(body);
  return {
    ...body,
    callerBodySha256,
    receiptSha256: sha256Canonical({ ...body, callerBodySha256 }),
  };
}

async function currentPrivateInvocationReceipt(command) {
  const receipt = structuredClone(await validPrivateInvocationReceipt(command));
  const issueReceipt = receipt.permitIssueReceipt;
  const issueIntent = issueReceipt.issueIntent;
  const permitEnvelope = issueReceipt.permitEnvelope;
  const attempt = receipt.invocationAuthority.attempt;
  const issuanceSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1",
    status: "permit_issuance_recorded",
    campaignIdSha256: receipt.campaignIdSha256,
    campaignBindingSha256: attempt.campaignBindingSha256,
    planDigestSha256: receipt.planDigestSha256,
    phaseOrdinal: receipt.phaseOrdinal,
    phaseId: receipt.phaseId,
    phaseExecutionId: receipt.phaseExecutionId,
    issueIntentSha256: issueReceipt.issueIntentSha256,
    authorityRequestIdSha256: issueReceipt.authority.requestIdSha256,
    permitIdSha256: permitEnvelope.subject.permitIdSha256,
    permitSubjectSha256: permitEnvelope.subjectSha256,
    permitEnvelopeSha256: issueReceipt.permitEnvelopeSha256,
    issuerVersionId: issueReceipt.issuer.versionId,
    issuedAt: issueIntent.issuedAt,
    expiresAt: issueIntent.expiresAt,
    onePermitPerPhasePersisted: true,
    phaseIssuanceOrderEnforced: true,
    ambiguousRetryRejected: true,
  };
  issueReceipt.issuanceAuthority = {
    ...issuanceSubject,
    receiptSha256: sha256Canonical(issuanceSubject),
  };
  const {
    receiptSha256: _permitIssueDigest,
    ...permitIssueSubject
  } = issueReceipt;
  issueReceipt.receiptSha256 = sha256Canonical(permitIssueSubject);

  const {
    invocationBodySha256: _oldBodyDigest,
    receiptSha256: _oldReceiptDigest,
    ...receiptSubject
  } = receipt;
  const completion = receiptSubject.invocationAuthority.completion;
  receiptSubject.invocationAuthority = { attempt };
  const invocationBodySha256 = sha256Canonical(receiptSubject);
  const {
    receiptSha256: _completionDigest,
    ...completionSubject
  } = completion;
  completionSubject.permitIssueReceiptSha256 = issueReceipt.receiptSha256;
  completionSubject.invocationBodySha256 = invocationBodySha256;
  const currentCompletion = {
    ...completionSubject,
    receiptSha256: sha256Canonical(completionSubject),
  };
  const currentSubject = {
    ...receiptSubject,
    invocationAuthority: { attempt, completion: currentCompletion },
    invocationBodySha256,
  };
  return {
    ...currentSubject,
    receiptSha256: sha256Canonical(currentSubject),
  };
}

function resealCallerReceipt(receipt) {
  const { callerBodySha256: _bodyDigest, receiptSha256: _digest, ...body } =
    receipt;
  Object.assign(receipt, sealCallerReceipt(body));
}

function resealRunnerReceipt(receipt) {
  const { runnerBodySha256: _bodyDigest, receiptSha256: _digest, ...body } =
    receipt;
  const runnerBodySha256 = sha256Canonical(body);
  receipt.runnerBodySha256 = runnerBodySha256;
  receipt.receiptSha256 = sha256Canonical({ ...body, runnerBodySha256 });
}

function rewriteDirectCallerApprovalAsV1(callerReceipt) {
  const runnerReceipt = callerReceipt.runnerReceipt;
  const operatorReceipt = runnerReceipt.operatorReceipt;
  const authorized = runnerReceipt.authorizedPhaseRequest;
  const approval = authorized.approval;
  approval.schemaVersion = 1;
  approval.contract =
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_V1_CONTRACT;
  approval.subject.schemaVersion = 1;
  approval.subject.contract =
    JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_V1_CONTRACT;
  delete approval.subject.planContract;
  delete approval.subject.planSchemaVersion;
  approval.subjectSha256 = sha256Canonical(approval.subject);

  Object.assign(operatorReceipt.authorization, {
    approvalEnvelope: structuredClone(approval),
    approvalEnvelopeSha256: sha256Canonical(approval),
    approvalSubjectSha256: approval.subjectSha256,
  });
  const {
    operatorBodySha256: _oldBodySha256,
    receiptSha256: _oldReceiptSha256,
    ...operatorBody
  } = operatorReceipt;
  operatorReceipt.operatorBodySha256 = sha256Canonical(operatorBody);
  const { receiptSha256: _ignored, ...operatorSubject } = operatorReceipt;
  operatorReceipt.receiptSha256 = sha256Canonical(operatorSubject);

  runnerReceipt.authorizedPhaseRequestSha256 = sha256Canonical(authorized);
  runnerReceipt.operatorReceiptSha256 = sha256Canonical(operatorReceipt);
  resealRunnerReceipt(runnerReceipt);
  callerReceipt.authorizedPhaseRequestSha256 =
    runnerReceipt.authorizedPhaseRequestSha256;
  callerReceipt.runnerReceiptSha256 = sha256Canonical(runnerReceipt);
  resealCallerReceipt(callerReceipt);
}

describe("JSON compatibility Caller offline receipt validation", () => {
  test("validates a direct Caller receipt through the complete Runner chain", async () => {
    const { plan, callerReceipt } = await invocationFixtures();
    const authorized = callerReceipt.runnerReceipt.authorizedPhaseRequest;
    expect(authorized).toMatchObject({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-operator-authorized-phase-request-v1",
      approval: {
        schemaVersion: 2,
        contract:
          JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_ENVELOPE_CONTRACT,
        subject: {
          schemaVersion: 2,
          contract:
            JSON_COMPATIBILITY_OPERATOR_PHASE_APPROVAL_SUBJECT_CONTRACT,
          planContract: plan.contract,
          planSchemaVersion: plan.schemaVersion,
        },
      },
    });
    expect(validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      callerReceipt,
      EXPECTED_CALLER,
    )).toBe(callerReceipt);

    const resolved = resolveJsonCompatibilityCallerCompletion(
      plan,
      callerReceipt,
      EXPECTED_CALLER,
    );
    const projection = projectJsonCompatibilityCallerCompletion(resolved);
    expect(projection).toMatchObject({
      contract: JSON_COMPATIBILITY_CALLER_INVOCATION_RECEIPT_CONTRACT,
      mode: "direct",
      receiptSha256: callerReceipt.receiptSha256,
      requestPayloadSha256: callerReceipt.authorizedPhaseRequestSha256,
      phaseStatus: "completed",
      caller: {
        versionId: CALLER_VERSION_ID,
      },
      callerPlanBinding: {
        versionId: CALLER_VERSION_ID,
        configSha256: CALLER_CONFIG_SHA256,
      },
      runner: {
        versionId: RUNNER_VERSION_ID,
        configSha256: RUNNER_CONFIG_SHA256,
      },
      completion: {
        executionRetryPermitted: false,
        runnerInvokePhaseCalled: true,
        runnerGetPhaseStatusCalled: false,
        originalCallerReceiptAvailable: true,
      },
    });
    expect(projectJsonCompatibilityResolvedRunner(resolved)).toMatchObject({
      mode: "direct",
      receiptSha256: callerReceipt.runnerReceipt.receiptSha256,
      completion: { executionRetryPermitted: false },
    });
    expect(projection.runnerRawReceiptSha256).toBe(
      callerReceipt.runnerReceiptSha256,
    );
    expect(projection.runnerClaimedReceiptSha256).toBe(
      callerReceipt.runnerReceipt.receiptSha256,
    );
    expect(projection.runnerRawReceiptSha256).not.toBe(
      projection.runnerClaimedReceiptSha256,
    );
    expect(projectJsonCompatibilityCallerCompletion(resolved))
      .toEqual(projection);
  });

  test("validates status recovery without repeating execution", async () => {
    const { plan, callerReceipt } = await statusFixtures();
    expect(validateJsonCompatibilityCallerStatusReceipt(
      plan,
      callerReceipt,
      EXPECTED_CALLER,
    )).toBe(callerReceipt);

    const resolved = resolveJsonCompatibilityCallerCompletion(
      plan,
      callerReceipt,
      EXPECTED_CALLER,
    );
    expect(projectJsonCompatibilityCallerCompletion(resolved)).toMatchObject({
      contract: JSON_COMPATIBILITY_CALLER_STATUS_RECEIPT_CONTRACT,
      mode: "recovered-status",
      phaseStatus: "completed",
      completion: {
        executionRetryPermitted: false,
        runnerInvokePhaseCalled: false,
        runnerGetPhaseStatusCalled: true,
        originalCallerReceiptAvailable: false,
      },
    });
    expect(projectJsonCompatibilityResolvedRunner(resolved)).toMatchObject({
      mode: "recovered-status",
      completion: {
        executionRetryPermitted: false,
        operatorInvokePhaseCalled: false,
      },
    });
  });

  test("rejects a resealed current approval v1 through the Caller chain", async () => {
    const currentV1 = await invocationFixtures();
    rewriteDirectCallerApprovalAsV1(currentV1.callerReceipt);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      currentV1.plan,
      currentV1.callerReceipt,
      EXPECTED_CALLER,
    )).toThrow(/approval envelope schema/);
  });

  test("anchors Caller version and config in the validated Plan", async () => {
    const { plan, callerReceipt } = await invocationFixtures();
    expect(validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      callerReceipt,
    )).toBe(callerReceipt);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      callerReceipt,
      { ...EXPECTED_CALLER, configSha256: "ff".repeat(32) },
    )).toThrow("expected caller config digest does not match");
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      callerReceipt,
      { ...EXPECTED_CALLER, serviceName: "untrusted" },
    )).toThrow("expected caller fields are invalid");

    const callerDrift = structuredClone(callerReceipt);
    callerDrift.caller.versionId = "detached-caller-version";
    resealCallerReceipt(callerDrift);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      callerDrift,
      EXPECTED_CALLER,
    )).toThrow("caller versionId does not match");
  });

  test("rejects binding drift and a payload detached from the Runner", async () => {
    const { plan, callerReceipt } = await invocationFixtures();
    const wrongBinding = structuredClone(callerReceipt);
    wrongBinding.privateTransport.runnerBinding = "RUNNER";
    resealCallerReceipt(wrongBinding);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      wrongBinding,
      EXPECTED_CALLER,
    )).toThrow("transport runnerBinding does not match");

    const detachedPayload = structuredClone(callerReceipt);
    detachedPayload.authorizedPhaseRequestSha256 = "ff".repeat(32);
    resealCallerReceipt(detachedPayload);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      detachedPayload,
      EXPECTED_CALLER,
    )).toThrow("request payload digest does not match");
  });

  test("rejects nested Runner version drift even after all digests are resealed", async () => {
    const { plan, callerReceipt } = await invocationFixtures();
    const detached = structuredClone(callerReceipt);
    detached.runnerReceipt.runner.versionId = "detached-runner-version";
    resealRunnerReceipt(detached.runnerReceipt);
    detached.runnerReceiptSha256 = sha256Canonical(detached.runnerReceipt);
    resealCallerReceipt(detached);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      detached,
      EXPECTED_CALLER,
    )).toThrow("runner versionId does not match");

    const configDrift = structuredClone(callerReceipt);
    configDrift.runner.configSha256 = "ff".repeat(32);
    resealCallerReceipt(configDrift);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      configDrift,
      EXPECTED_CALLER,
    )).toThrow("runner configSha256 does not match");
  });

  test("binds the status payload digest to the exact Caller request", async () => {
    const { plan, callerReceipt } = await statusFixtures();
    callerReceipt.callerStatusRequestSha256 = "ff".repeat(32);
    resealCallerReceipt(callerReceipt);
    expect(() => validateJsonCompatibilityCallerStatusReceipt(
      plan,
      callerReceipt,
      EXPECTED_CALLER,
    )).toThrow("request payload digest does not match");
  });

  test("requires one ambiguity-rejecting authority attempt and no recovery execution", async () => {
    const direct = await invocationFixtures();
    expect(
      direct.callerReceipt.runnerReceipt.operatorReceipt
        .privateInvocationReceipt.invocationAuthority.attempt,
    ).toMatchObject({
      oneAttemptPerPhasePersisted: true,
      phaseOrderEnforced: true,
      ambiguousRetryRejected: true,
    });
    expect(validateJsonCompatibilityCallerInvocationReceipt(
      direct.plan,
      direct.callerReceipt,
      EXPECTED_CALLER,
    )).toBe(direct.callerReceipt);

    const recovered = await statusFixtures();
    recovered.callerReceipt.recovery.runnerInvokePhaseCalled = true;
    resealCallerReceipt(recovered.callerReceipt);
    expect(() => validateJsonCompatibilityCallerStatusReceipt(
      recovered.plan,
      recovered.callerReceipt,
      EXPECTED_CALLER,
    )).toThrow("execution call does not match");
  });

  test("rejects receipt/body digest drift and unsupported contracts", async () => {
    const { plan, callerReceipt } = await invocationFixtures();
    const bodyDrift = structuredClone(callerReceipt);
    bodyDrift.callerBodySha256 = "ff".repeat(32);
    expect(() => validateJsonCompatibilityCallerInvocationReceipt(
      plan,
      bodyDrift,
      EXPECTED_CALLER,
    )).toThrow("body digest does not match");

    expect(() => resolveJsonCompatibilityCallerCompletion(
      plan,
      { contract: "unsupported-caller-receipt" },
      EXPECTED_CALLER,
    )).toThrow("[caller] receipt contract is unsupported");
  });
});
