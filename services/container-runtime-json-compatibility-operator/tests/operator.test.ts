import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  verifyJsonCompatibilityInvokeCommand,
  type JsonCompatibilityInvokeCommandV1,
} from "../../container-runtime-json-compatibility-invoker/src/authorization";
import {
  JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
} from "../../container-runtime-json-compatibility-permit-issuer/src/protocol";
import {
  JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
  JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
  parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1,
  parseJsonCompatibilityOperatorPhaseRequestV1,
} from "../src/protocol";
import {
  COMMAND_ID_DOMAIN,
  JSON_COMPATIBILITY_OPERATOR_ISSUER,
  JsonCompatibilityOperatorError,
  invokeJsonCompatibilityOperatorPhase,
} from "../src/operator";
import {
  INVOKER_VERSION_ID,
  NOW_MS,
  OPERATOR_CREDENTIAL_ID_SHA256,
  OPERATOR_APPROVAL_KEY_ID,
  OPERATOR_APPROVAL_SPKI_SHA256,
  OPERATOR_KEY_ID,
  OPERATOR_SECRET,
  OPERATOR_VERSION_ID,
  detachedPrivateInvocationReceipt,
  operatorEnv,
  record,
  runtimeSequence,
  validAuthorizedOperatorRequest,
  validOperatorRequest,
  validPrivateInvocationReceipt,
} from "./fixtures";

const RECEIPT_KEYS = [
  "schemaVersion",
  "contract",
  "status",
  "environment",
  "campaignIdSha256",
  "planDigestSha256",
  "phaseExecutionId",
  "phaseOrdinal",
  "phaseId",
  "operator",
  "authorization",
  "request",
  "requestSha256",
  "commandIdSha256",
  "privateTransport",
  "privateInvocationReceipt",
  "privateInvocationReceiptSha256",
  "startedAt",
  "completedAt",
  "operatorBodySha256",
  "receiptSha256",
] as const;

describe("JSON compatibility private operator", () => {
  test("requires an outer approval and rejects inner authorization fields", async () => {
    const request = validOperatorRequest();
    expect(() => parseJsonCompatibilityOperatorPhaseRequestV1({
      ...request,
      authorizationIdSha256: "aa".repeat(32),
    })).toThrowError(/invalid_operator_phase_request/u);
    expect(() => parseJsonCompatibilityOperatorPhaseRequestV1({
      ...request,
      issuedAt: Math.floor(NOW_MS / 1000),
    })).toThrowError(/invalid_operator_phase_request/u);
    expect(() => parseJsonCompatibilityOperatorPhaseRequestV1({
      ...request,
      execution: { ...request.execution, authorization: {} },
    })).toThrow();
    expect(() => parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(request))
      .toThrowError(/invalid_operator_phase_request/u);
    const authorized = await validAuthorizedOperatorRequest(request);
    expect(parseJsonCompatibilityOperatorAuthorizedPhaseRequestV1(authorized))
      .toEqual(authorized);
  });

  test("derives a deterministic command and signs it for the existing verifier", async () => {
    const request = validOperatorRequest();
    const authorized = await validAuthorizedOperatorRequest(request);
    const captured: JsonCompatibilityInvokeCommandV1[] = [];
    const invokePhase = async (input: unknown): Promise<unknown> => {
      const command = record(input) as JsonCompatibilityInvokeCommandV1;
      captured.push(command);
      return await validPrivateInvocationReceipt(command);
    };
    await invokeJsonCompatibilityOperatorPhase(
      operatorEnv(invokePhase),
      authorized,
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    );
    await invokeJsonCompatibilityOperatorPhase(
      operatorEnv(invokePhase),
      authorized,
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    );

    expect(captured).toHaveLength(2);
    expect(canonicalJson(captured[0])).toBe(canonicalJson(captured[1]));
    const expectedCommandId = await sha256Hex(
      `${COMMAND_ID_DOMAIN}${canonicalJson(request)}\n${OPERATOR_VERSION_ID}`,
    );
    expect(captured[0]?.subject.commandIdSha256).toBe(expectedCommandId);
    expect(captured[0]?.subject.issueIntent).toMatchObject({
      authorizationIdSha256: expectedCommandId,
      issuedAt: Math.floor(NOW_MS / 1000),
      notBefore: Math.floor(NOW_MS / 1000),
      expiresAt: Math.floor(NOW_MS / 1000) + 300,
    });
    expect(captured[0]?.authority.claims.expiresAt).toBe(
      Math.floor(NOW_MS / 1000) + 60,
    );
    await expect(verifyJsonCompatibilityInvokeCommand(
      {
        JSON_COMPATIBILITY_INVOKER_OPERATOR_ISSUER:
          JSON_COMPATIBILITY_OPERATOR_ISSUER,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_AUDIENCE:
          JSON_COMPATIBILITY_INVOKER_SERVICE_NAME,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: OPERATOR_KEY_ID,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_CREDENTIAL_ID_SHA256:
          OPERATOR_CREDENTIAL_ID_SHA256,
        JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256: "",
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET: OPERATOR_SECRET,
      },
      captured[0],
      INVOKER_VERSION_ID,
      NOW_MS,
    )).resolves.toMatchObject({
      authority: { commandIdSha256: expectedCommandId },
    });
  });

  test("calls the invoker once and returns the exact bounded digest chain", async () => {
    const request = validOperatorRequest();
    const authorized = await validAuthorizedOperatorRequest(request);
    let calls = 0;
    const receipt = await invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async (command) => {
        calls += 1;
        return await validPrivateInvocationReceipt(command);
      }),
      authorized,
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    );
    expect(calls).toBe(1);
    expect(Object.keys(receipt).sort()).toEqual([...RECEIPT_KEYS].sort());
    expect(receipt).toMatchObject({
      contract: JSON_COMPATIBILITY_OPERATOR_INVOCATION_RECEIPT_CONTRACT,
      status: "operator_phase_invocation_completed",
      operator: {
        serviceName: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
        versionId: OPERATOR_VERSION_ID,
        gateName: "JSON_COMPATIBILITY_OPERATOR_ENABLED",
      },
      authorization: {
        issuer:
          "cinatoken-json-compatibility-campaign-approval-authority-staging",
        audience: JSON_COMPATIBILITY_OPERATOR_SERVICE_NAME,
        keyId: "json-campaign-approval-2026-08",
        caller: {
          serviceName:
            "cinatoken-container-runtime-json-compatibility-runner-staging",
          versionId: "runner-version-001",
        },
      },
      privateTransport: {
        kind: "service-binding-rpc",
        publicUrlUsed: false,
        cloudflareRestUsed: false,
        invokerBinding: "JSON_COMPATIBILITY_INVOKER_SERVICE",
      },
    });
    expect(receipt.requestSha256).toBe(
      await sha256Hex(canonicalJson(request)),
    );
    expect(receipt.privateInvocationReceiptSha256).toBe(
      await sha256Hex(canonicalJson(receipt.privateInvocationReceipt)),
    );
    const {
      operatorBodySha256,
      receiptSha256,
      ...body
    } = receipt;
    expect(operatorBodySha256).toBe(await sha256Hex(canonicalJson(body)));
    expect(receiptSha256).toBe(await sha256Hex(canonicalJson({
      ...body,
      operatorBodySha256,
    })));
    expect(new TextEncoder().encode(canonicalJson(receipt)).byteLength)
      .toBeLessThanOrEqual(1792 * 1024);
  });

  test("rejects tampered, unknown-key, and expired approvals before RPC", async () => {
    const candidates = [];
    const tamperedRequest = await validAuthorizedOperatorRequest();
    (tamperedRequest.request as { beforeContextSha256: string })
      .beforeContextSha256 = "aa".repeat(32);
    candidates.push({ input: tamperedRequest, code: "invalid_operator_phase_approval" });

    const tamperedSignature = await validAuthorizedOperatorRequest();
    (tamperedSignature.approval as { signatureBase64url: string })
      .signatureBase64url =
      `${tamperedSignature.approval.signatureBase64url.slice(0, -1)}B`;
    candidates.push({ input: tamperedSignature, code: "invalid_operator_phase_approval" });

    candidates.push({
      input: await validAuthorizedOperatorRequest(validOperatorRequest(), {
        keyId: "untrusted-approval-key",
      }),
      code: "invalid_operator_phase_approval",
    });
    candidates.push({
      input: await validAuthorizedOperatorRequest(validOperatorRequest(), {
        issuedAt: NOW_MS / 1000 - 1_000,
      }),
      code: "operator_phase_approval_time_window",
    });

    for (const candidate of candidates) {
      let calls = 0;
      await expect(invokeJsonCompatibilityOperatorPhase(
        operatorEnv(async () => {
          calls += 1;
          throw new Error("must not be called");
        }),
        candidate.input,
        runtimeSequence(NOW_MS),
      )).rejects.toMatchObject({ code: candidate.code });
      expect(calls).toBe(0);
    }
  });

  test("accepts an exact previous approval key and rejects partial rotation", async () => {
    const authorized = await validAuthorizedOperatorRequest();
    const rotating = operatorEnv(async (command) =>
      await validPrivateInvocationReceipt(command));
    Object.assign(rotating, {
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_KID:
        "json-campaign-approval-next",
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_CURRENT_SPKI_SHA256:
        "ab".repeat(32),
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID:
        OPERATOR_APPROVAL_KEY_ID,
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_SPKI_SHA256:
        OPERATOR_APPROVAL_SPKI_SHA256,
    });
    await expect(invokeJsonCompatibilityOperatorPhase(
      rotating,
      authorized,
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    )).resolves.toMatchObject({ status: "operator_phase_invocation_completed" });

    let calls = 0;
    const partial = operatorEnv(async () => {
      calls += 1;
      throw new Error("must not be called");
    });
    Object.assign(partial, {
      JSON_COMPATIBILITY_OPERATOR_APPROVAL_PREVIOUS_KID:
        OPERATOR_APPROVAL_KEY_ID,
    });
    await expect(invokeJsonCompatibilityOperatorPhase(
      partial,
      authorized,
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "operator_approval_verifier_unavailable" });
    expect(calls).toBe(0);
  });

  test("accepts the invoker verifier's five-second clock skew and rejects more", async () => {
    for (const offsetSeconds of [-5, 5]) {
      await expect(invokeJsonCompatibilityOperatorPhase(
        operatorEnv(async (command) =>
          await validPrivateInvocationReceipt(command, offsetSeconds)),
        await validAuthorizedOperatorRequest(),
        runtimeSequence(NOW_MS, NOW_MS + 2_000),
      )).resolves.toMatchObject({
        status: "operator_phase_invocation_completed",
      });
    }
    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async (command) =>
        await validPrivateInvocationReceipt(command, -6)),
      await validAuthorizedOperatorRequest(),
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    )).rejects.toMatchObject({ code: "invalid_private_invocation_receipt" });
  });

  test("fails closed while disabled or missing its secret", async () => {
    let calls = 0;
    const invokePhase = async (): Promise<unknown> => {
      calls += 1;
      throw new Error("must not be called");
    };
    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(invokePhase, false),
      await validAuthorizedOperatorRequest(),
    )).rejects.toMatchObject({ code: "operator_disabled" });
    const missingSecret = operatorEnv(invokePhase);
    delete missingSecret.JSON_COMPATIBILITY_OPERATOR_CURRENT_SECRET;
    await expect(invokeJsonCompatibilityOperatorPhase(
      missingSecret,
      await validAuthorizedOperatorRequest(),
    )).rejects.toMatchObject({ code: "operator_configuration_error" });
    expect(calls).toBe(0);
  });

  test("rejects malformed and detached receipts without retrying", async () => {
    for (const mode of ["extra-key", "detached-completion"] as const) {
      let calls = 0;
      await expect(invokeJsonCompatibilityOperatorPhase(
        operatorEnv(async (command) => {
          calls += 1;
          const valid = await validPrivateInvocationReceipt(command);
          if (mode === "extra-key") return { ...valid, unexpected: true };
          return await detachedPrivateInvocationReceipt(valid);
        }),
        await validAuthorizedOperatorRequest(),
        runtimeSequence(NOW_MS, NOW_MS + 2_000),
      )).rejects.toBeInstanceOf(JsonCompatibilityOperatorError);
      expect(calls).toBe(1);
    }
  });

  test("rejects oversized output and upstream failure without retrying", async () => {
    let oversizedCalls = 0;
    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async (command) => {
        oversizedCalls += 1;
        const valid = await validPrivateInvocationReceipt(command);
        const executorReceipt = record(valid.executorReceipt);
        return {
          ...valid,
          executorReceipt: {
            ...executorReceipt,
            observations: ["x".repeat(1536 * 1024)],
          },
        };
      }),
      await validAuthorizedOperatorRequest(),
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    )).rejects.toMatchObject({
      code: "invalid_private_invocation_receipt",
    });
    expect(oversizedCalls).toBe(1);

    let deepCalls = 0;
    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async (command) => {
        deepCalls += 1;
        const valid = await validPrivateInvocationReceipt(command);
        let deep: Record<string, unknown> = {};
        for (let index = 0; index < 70; index += 1) deep = { deep };
        return {
          ...valid,
          executorReceipt: {
            ...record(valid.executorReceipt),
            observations: [deep],
          },
        };
      }),
      await validAuthorizedOperatorRequest(),
      runtimeSequence(NOW_MS, NOW_MS + 2_000),
    )).rejects.toMatchObject({
      code: "invalid_private_invocation_receipt",
    });
    expect(deepCalls).toBe(1);

    let failureCalls = 0;
    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async () => {
        failureCalls += 1;
        throw new Error("binding unavailable");
      }),
      await validAuthorizedOperatorRequest(),
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invoker_unavailable" });
    expect(failureCalls).toBe(1);
  });

  test("classifies only known invoker codes as business rejections", async () => {
    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async () => {
        throw { code: "invalid_executor_receipt" };
      }),
      await validAuthorizedOperatorRequest(),
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invoker_rejected" });

    await expect(invokeJsonCompatibilityOperatorPhase(
      operatorEnv(async () => {
        throw { code: "ECONNRESET" };
      }),
      await validAuthorizedOperatorRequest(),
      runtimeSequence(NOW_MS),
    )).rejects.toMatchObject({ code: "invoker_unavailable" });
  });
});
