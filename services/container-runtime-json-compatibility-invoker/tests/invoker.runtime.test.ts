import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  createJsonHealthProbeDigestRecord,
  serializeJsonHealthProbeWireRequest,
  sha256Hex,
  type JsonCompatibilityProbeRequestV1,
  type JsonCompatibilityProbeResultV1,
} from "../../container-controller/src/json_compatibility_probe";
import {
  executeJsonCompatibilityPhase,
  type JsonCompatibilityExecutorEnv,
  type JsonCompatibilityExecutorRuntime,
} from "../../container-runtime-json-compatibility-executor/src/executor";
import type {
  JsonCompatibilityCampaignLeaseBeginResult,
  JsonCompatibilityCampaignLeaseBeginV1,
  JsonCompatibilityCampaignLeaseCompleteV1,
  JsonCompatibilityCampaignLeaseFailV1,
  JsonCompatibilityCampaignLeaseTerminalResult,
  JsonCompatibilityExecutePhaseRequestV2,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import {
  issueJsonCompatibilityPhasePermit,
  type JsonCompatibilityPermitIssuerEnv,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";
import type {
  JsonCompatibilityPermitIssuanceRecordV1,
} from "../../container-runtime-json-compatibility-permit-issuer/src/issuance_authority";
import {
  invokeJsonCompatibilityPhase,
  type JsonCompatibilityInvokerEnv,
} from "../src/invoker";
import type { JsonCompatibilityInvocationAuthority } from "../src/invocation_authority";
import {
  INVOKER_VERSION_ID,
  ISSUER_HMAC_CREDENTIAL_ID_SHA256,
  ISSUER_HMAC_KEY_ID,
  ISSUER_HMAC_SECRET,
  NOW_MS,
  OPERATOR_CREDENTIAL_ID_SHA256,
  OPERATOR_ISSUER,
  OPERATOR_KEY_ID,
  OPERATOR_SECRET,
  PERMIT_KEY_ID,
  PERMIT_PKCS8,
  PERMIT_SPKI,
  PERMIT_SPKI_SHA256,
  encodeBase64url,
  validIntent,
  validInvokeCommand,
} from "./fixtures";

declare global {
  namespace Cloudflare {
    interface Env {
      JSON_COMPATIBILITY_INVOCATION_AUTHORITY:
        DurableObjectNamespace<JsonCompatibilityInvocationAuthority>;
    }
  }
}

class RecordingProbeBinding {
  readonly calls: JsonCompatibilityProbeRequestV1[] = [];

  async probeShard(request: JsonCompatibilityProbeRequestV1): Promise<unknown> {
    this.calls.push(request);
    return await successfulProbeResult(request);
  }
}

class RecordingCampaignAuthority {
  readonly beginCalls: JsonCompatibilityCampaignLeaseBeginV1[] = [];
  readonly completeCalls: JsonCompatibilityCampaignLeaseCompleteV1[] = [];
  readonly failCalls: JsonCompatibilityCampaignLeaseFailV1[] = [];

  async beginPhase(
    input: JsonCompatibilityCampaignLeaseBeginV1,
  ): Promise<JsonCompatibilityCampaignLeaseBeginResult> {
    this.beginCalls.push(input);
    const receiptSubject = {
      schemaVersion: 1 as const,
      contract:
        "cinatoken-container-runtime-json-compatibility-campaign-lease-receipt-v1" as const,
      status: "phase_lease_acquired" as const,
      campaignIdSha256: input.campaignIdSha256,
      campaignBindingSha256: input.campaignBindingSha256,
      planDigestSha256: input.planDigestSha256,
      permitIdSha256: input.permitIdSha256,
      permitSubjectSha256: input.permitSubjectSha256,
      permitEnvelopeSha256: input.permitEnvelopeSha256,
      phaseOrdinal: input.phaseOrdinal,
      phaseId: input.phaseId,
      phaseExecutionId: input.phaseExecutionId,
      leaseIdSha256: input.leaseIdSha256,
      executorVersionId: input.executorVersionId,
      acquiredAt: input.acquiredAt,
      permitExpiresAt: input.permitExpiresAt,
      singleUsePermitPersisted: true as const,
      phaseOrderEnforced: true as const,
      concurrentPhaseRejected: true as const,
    };
    return {
      ok: true,
      receipt: {
        ...receiptSubject,
        leaseReceiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
      },
    };
  }

  async completePhase(
    input: JsonCompatibilityCampaignLeaseCompleteV1,
  ): Promise<JsonCompatibilityCampaignLeaseTerminalResult> {
    this.completeCalls.push(input);
    return { ok: true, status: "phase_completed" };
  }

  async failPhase(
    input: JsonCompatibilityCampaignLeaseFailV1,
  ): Promise<JsonCompatibilityCampaignLeaseTerminalResult> {
    this.failCalls.push(input);
    return { ok: true, status: "campaign_failed" };
  }
}

interface RuntimeHarness {
  readonly invokerEnv: JsonCompatibilityInvokerEnv;
  readonly issuerCalls: unknown[];
  readonly executorCalls: unknown[];
  readonly probe: RecordingProbeBinding;
  readonly executorAuthority: RecordingCampaignAuthority;
}

function createHarness(options: {
  issuerFailureCode?: string;
  invalidExecutorReceipt?: boolean;
} = {}): RuntimeHarness {
  const issuerCalls: unknown[] = [];
  const executorCalls: unknown[] = [];
  const probe = new RecordingProbeBinding();
  const executorAuthority = new RecordingCampaignAuthority();
  const issuerBinding = {
    async issuePhasePermit(input: unknown): Promise<unknown> {
      issuerCalls.push(input);
      if (options.issuerFailureCode !== undefined) {
        throw { code: options.issuerFailureCode };
      }
      return await issueJsonCompatibilityPhasePermit(
        permitIssuerEnv(recordIssuance),
        input,
        NOW_MS,
      );
    },
  };
  const executorBinding = {
    async executePhase(input: unknown): Promise<unknown> {
      executorCalls.push(input);
      if (options.invalidExecutorReceipt === true) return {};
      return await executeJsonCompatibilityPhase(
        executorEnv(probe, executorAuthority),
        input,
        deterministicExecutorRuntime(),
      );
    },
  };
  return {
    issuerCalls,
    executorCalls,
    probe,
    executorAuthority,
    invokerEnv: {
      ENVIRONMENT: "staging",
      JSON_COMPATIBILITY_INVOKER_ENABLED: "true",
      CF_VERSION_METADATA: { id: INVOKER_VERSION_ID },
      JSON_COMPATIBILITY_INVOCATION_AUTHORITY:
        env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY,
      JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE: issuerBinding,
      JSON_COMPATIBILITY_EXECUTOR_SERVICE: executorBinding,
      JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER: OPERATOR_ISSUER,
      JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: OPERATOR_KEY_ID,
      JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
        OPERATOR_CREDENTIAL_ID_SHA256,
      JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
      JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
      JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET: OPERATOR_SECRET,
      JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_ISSUER:
        "cinatoken-container-runtime-json-compatibility-invoker-staging",
      JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_AUDIENCE:
        "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
      JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_KID: ISSUER_HMAC_KEY_ID,
      JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_CREDENTIAL_ID_SHA256:
        ISSUER_HMAC_CREDENTIAL_ID_SHA256,
      JSON_COMPATIBILITY_INVOKER_ISSUER_HMAC_SECRET: ISSUER_HMAC_SECRET,
      JSON_COMPATIBILITY_PERMIT_ISSUER:
        "cinatoken-json-compatibility-permit-issuer-staging",
      JSON_COMPATIBILITY_PERMIT_AUDIENCE:
        "cinatoken-container-runtime-json-compatibility-executor-staging",
      JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
      JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
      JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL:
        encodeBase64url(PERMIT_SPKI),
    },
  };
}

function permitIssuerEnv(
  record: (input: JsonCompatibilityPermitIssuanceRecordV1) => Promise<unknown>,
): JsonCompatibilityPermitIssuerEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED: "true",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_ISSUER:
      "cinatoken-container-runtime-json-compatibility-invoker-staging",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_AUDIENCE:
      "cinatoken-container-runtime-json-compatibility-permit-issuer-staging",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_KID: ISSUER_HMAC_KEY_ID,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_CREDENTIAL_ID_SHA256:
      ISSUER_HMAC_CREDENTIAL_ID_SHA256,
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_KID: "",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_PREVIOUS_CREDENTIAL_ID_SHA256: "",
    JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_SECRET: ISSUER_HMAC_SECRET,
    JSON_COMPATIBILITY_PERMIT_ISSUER:
      "cinatoken-json-compatibility-permit-issuer-staging",
    JSON_COMPATIBILITY_PERMIT_AUDIENCE:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
    JSON_COMPATIBILITY_PERMIT_PKCS8_BASE64URL:
      encodeBase64url(PERMIT_PKCS8),
    JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL: encodeBase64url(PERMIT_SPKI),
    CF_VERSION_METADATA: { id: "permit-issuer-version-001" },
    JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY: {
      getByName: () => ({ recordIssuance: record }),
    } as DurableObjectNamespace,
  };
}

function executorEnv(
  probe: RecordingProbeBinding,
  authority: RecordingCampaignAuthority,
): JsonCompatibilityExecutorEnv {
  return {
    ENVIRONMENT: "staging",
    JSON_COMPATIBILITY_EXECUTOR_ENABLED: "true",
    CF_VERSION_METADATA: { id: "executor-version-001" },
    CONTAINER_CONTROLLER_JSON_PROBE: probe,
    JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY: {
      getByName: () => authority,
    } as DurableObjectNamespace,
    JSON_COMPATIBILITY_PERMIT_ISSUER:
      "cinatoken-json-compatibility-permit-issuer-staging",
    JSON_COMPATIBILITY_PERMIT_AUDIENCE:
      "cinatoken-container-runtime-json-compatibility-executor-staging",
    JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
    JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
    JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL: encodeBase64url(PERMIT_SPKI),
  } as JsonCompatibilityExecutorEnv;
}

function deterministicExecutorRuntime(): JsonCompatibilityExecutorRuntime {
  let sequence = 0;
  return {
    now: () => NOW_MS,
    randomUUID: () => {
      sequence += 1;
      return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
    },
  };
}

async function recordIssuance(
  input: JsonCompatibilityPermitIssuanceRecordV1,
): Promise<unknown> {
  const receiptSubject = {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1" as const,
    status: "permit_issuance_recorded" as const,
    campaignIdSha256: input.campaignIdSha256,
    campaignBindingSha256: input.campaignBindingSha256,
    planDigestSha256: input.planDigestSha256,
    phaseOrdinal: input.phaseOrdinal,
    phaseId: input.phaseId,
    phaseExecutionId: input.phaseExecutionId,
    issueIntentSha256: input.issueIntentSha256,
    authorityRequestIdSha256: input.authorityRequestIdSha256,
    permitIdSha256: input.permitIdSha256,
    permitSubjectSha256: input.permitSubjectSha256,
    permitEnvelopeSha256: input.permitEnvelopeSha256,
    issuerVersionId: input.issuerVersionId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    onePermitPerPhasePersisted: true as const,
    phaseIssuanceOrderEnforced: true as const,
    ambiguousRetryRejected: true as const,
  };
  return {
    ok: true,
    receipt: {
      ...receiptSubject,
      receiptSha256: await sha256Hex(canonicalJson(receiptSubject)),
    },
  };
}

async function successfulProbeResult(
  request: JsonCompatibilityProbeRequestV1,
): Promise<JsonCompatibilityProbeResultV1> {
  const requestRawJson = serializeJsonHealthProbeWireRequest(request);
  const responseRawJson = JSON.stringify({
    protocol_version: 1,
    operation_id: request.operation.operationId,
    status: "completed",
    trace_id: request.operation.traceId,
  });
  const readinessRawJson = JSON.stringify({
    status: "ready",
    protocol_version: 1,
    runtime_build_id: request.expectedRuntimeBuildIdSha256,
    shard_contract_version: 1,
    execution_enabled: false,
  });
  return {
    schemaVersion: 1,
    contract: "cinatoken-container-runtime-json-probe-result-v1",
    request,
    startedAt: request.requestedAt,
    completedAt: request.requestedAt,
    readiness: {
      statusCode: 200,
      contentType: "application/json",
      rawJson: readinessRawJson,
      rawByteLength: new TextEncoder().encode(readinessRawJson).byteLength,
      rawSha256: await sha256Hex(readinessRawJson),
      runtimeBuildIdSha256: request.expectedRuntimeBuildIdSha256,
      protocolVersion: 1,
      shardContractVersion: 1,
      executionEnabled: false,
    },
    healthProbe: {
      operationKind: "health_probe",
      statusCode: 200,
      requestContentType: "application/json",
      responseContentType: "application/json",
      requestRawJson,
      responseRawJson,
      ...await createJsonHealthProbeDigestRecord(requestRawJson, responseRawJson),
      selectedTransport: "json",
      effectiveTransport: "json",
      attemptCount: 1,
      legacyJsonFallbackCount: 0,
      outcome: "completed",
      recoveryRequired: false,
    },
    sideEffects: {
      providerRequestCount: 0,
      billingMutationCount: 0,
      storageGatewayMutationCount: 0,
      productionTrafficRequestCount: 0,
      publicProbeRequestCount: 0,
    },
  };
}

describe("private JSON compatibility campaign invoker runtime", () => {
  test("authenticates, issues one permit, executes privately, and persists completion", async () => {
    const harness = createHarness();
    const command = await validInvokeCommand(
      validIntent("baseline-n-minus-one", "21".repeat(32)),
    );
    const receipt = await invokeJsonCompatibilityPhase(
      harness.invokerEnv,
      command,
      { now: () => NOW_MS },
    );

    expect(harness.issuerCalls).toHaveLength(1);
    expect(harness.executorCalls).toHaveLength(1);
    expect(harness.probe.calls).toHaveLength(8);
    expect(harness.executorAuthority.beginCalls).toHaveLength(1);
    expect(harness.executorAuthority.completeCalls).toHaveLength(1);
    expect(receipt.privateTransport).toEqual({
      kind: "service-binding-rpc",
      publicUrlUsed: false,
      cloudflareRestUsed: false,
      permitIssuerBinding: "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      executorBinding: "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
    });
    expect(receipt.invocationAuthority.completion).toMatchObject({
      status: "invocation_phase_completed",
      attemptCompletionPersisted: true,
      phaseOrderAdvanced: true,
      campaignTerminal: false,
    });
    const { receiptSha256, ...subject } = receipt;
    expect(receiptSha256).toBe(await sha256Hex(canonicalJson(subject)));
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
  });

  test("stops before all bindings while default-off", async () => {
    const harness = createHarness();
    const disabled = {
      ...harness.invokerEnv,
      JSON_COMPATIBILITY_INVOKER_ENABLED: "false",
    };
    await expect(invokeJsonCompatibilityPhase(
      disabled,
      await validInvokeCommand(validIntent(
        "baseline-n-minus-one",
        "31".repeat(32),
      )),
      { now: () => NOW_MS },
    )).rejects.toMatchObject({ code: "invoker_disabled" });
    expect(harness.issuerCalls).toHaveLength(0);
    expect(harness.executorCalls).toHaveLength(0);
    expect(harness.probe.calls).toHaveLength(0);
  });

  test("makes issuer rejection terminal without calling the executor", async () => {
    const harness = createHarness({ issuerFailureCode: "permit_issuer_disabled" });
    const command = await validInvokeCommand(
      validIntent("baseline-n-minus-one", "41".repeat(32)),
    );
    await expect(invokeJsonCompatibilityPhase(
      harness.invokerEnv,
      command,
      { now: () => NOW_MS },
    )).rejects.toMatchObject({ code: "permit_issuer_rejected" });
    expect(harness.issuerCalls).toHaveLength(1);
    expect(harness.executorCalls).toHaveLength(0);

    await expect(invokeJsonCompatibilityPhase(
      harness.invokerEnv,
      command,
      { now: () => NOW_MS },
    )).rejects.toMatchObject({ code: "invocation_authority_conflict" });
    expect(harness.issuerCalls).toHaveLength(1);
  });

  test("rejects an invalid executor receipt and terminalizes the campaign", async () => {
    const harness = createHarness({ invalidExecutorReceipt: true });
    const command = await validInvokeCommand(
      validIntent("baseline-n-minus-one", "51".repeat(32)),
    );
    await expect(invokeJsonCompatibilityPhase(
      harness.invokerEnv,
      command,
      { now: () => NOW_MS },
    )).rejects.toMatchObject({ code: "invalid_executor_receipt" });
    expect(harness.issuerCalls).toHaveLength(1);
    expect(harness.executorCalls).toHaveLength(1);
    expect(harness.probe.calls).toHaveLength(0);

    await expect(invokeJsonCompatibilityPhase(
      harness.invokerEnv,
      command,
      { now: () => NOW_MS },
    )).rejects.toMatchObject({ code: "invocation_authority_conflict" });
    expect(harness.executorCalls).toHaveLength(1);
  });
});
