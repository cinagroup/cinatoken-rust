import { describe, expect, test } from "vitest";

import {
  JsonCompatibilityInvokerAuthorizationError,
  verifyJsonCompatibilityInvocationStatusQuery,
  verifyJsonCompatibilityInvokeCommand,
} from "../src/authorization";
import {
  INVOKER_VERSION_ID,
  NOW_MS,
  OPERATOR_CREDENTIAL_ID_SHA256,
  OPERATOR_KEY_ID,
  OPERATOR_SECRET,
  STATUS_OPERATOR_CREDENTIAL_ID_SHA256,
  STATUS_OPERATOR_KEY_ID,
  operatorEnv,
  statusOperatorEnv,
  validIntent,
  validInvokeCommand,
  validStatusQuery,
} from "./fixtures";

describe("JSON compatibility invoker operator authorization", () => {
  test("verifies a digest-bound current operator credential", async () => {
    const command = await validInvokeCommand();
    const verified = await verifyJsonCompatibilityInvokeCommand(
      operatorEnv(),
      command,
      INVOKER_VERSION_ID,
      NOW_MS,
    );
    expect(verified.command).toEqual(command);
    expect(verified.authority).toMatchObject({
      keyId: OPERATOR_KEY_ID,
      credentialIdSha256: OPERATOR_CREDENTIAL_ID_SHA256,
      commandIdSha256: command.subject.commandIdSha256,
      issuedAt: command.authority.claims.issuedAt,
      expiresAt: command.authority.claims.expiresAt,
    });
    expect(verified.authority.commandSubjectSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.authority.authorityEnvelopeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("accepts the explicitly pinned previous credential during rotation", async () => {
    const previousKeyId = "json-campaign-operator-previous-2026-07";
    const previousCredential = "c1".repeat(32);
    const previousSecret = `${OPERATOR_SECRET}-previous`;
    const command = await validInvokeCommand(
      validIntent(),
      previousSecret,
      previousKeyId,
      previousCredential,
    );
    const env = {
      ...operatorEnv(),
      JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_KID: previousKeyId,
      JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_CREDENTIAL_ID_SHA256:
        previousCredential,
      JSON_COMPATIBILITY_INVOKER_OPERATOR_PREVIOUS_SECRET: previousSecret,
    };
    await expect(verifyJsonCompatibilityInvokeCommand(
      env,
      command,
      INVOKER_VERSION_ID,
      NOW_MS,
    )).resolves.toMatchObject({ authority: { keyId: previousKeyId } });
  });

  test("rejects signature, command binding, version, and time-window drift", async () => {
    const command = await validInvokeCommand();
    const tampered = {
      ...command,
      authority: {
        ...command.authority,
        signatureBase64url:
          `${command.authority.signatureBase64url.startsWith("A") ? "B" : "A"}${
            command.authority.signatureBase64url.slice(1)
          }`,
      },
    };
    await expect(verifyJsonCompatibilityInvokeCommand(
      statusOperatorEnv(),
      tampered,
      INVOKER_VERSION_ID,
      NOW_MS,
    )).rejects.toBeInstanceOf(JsonCompatibilityInvokerAuthorizationError);

    await expect(verifyJsonCompatibilityInvokeCommand(
      statusOperatorEnv(),
      command,
      "different-invoker-version",
      NOW_MS,
    )).rejects.toMatchObject({ code: "invoke_authority_binding_mismatch" });

    const substituted = {
      ...command,
      subject: { ...command.subject, issueIntent: validIntent("candidate-n") },
    };
    await expect(verifyJsonCompatibilityInvokeCommand(
      operatorEnv(),
      substituted,
      INVOKER_VERSION_ID,
      NOW_MS,
    )).rejects.toMatchObject({ code: "invoke_authority_binding_mismatch" });

    await expect(verifyJsonCompatibilityInvokeCommand(
      operatorEnv(),
      command,
      INVOKER_VERSION_ID,
      NOW_MS + 61_000,
    )).rejects.toMatchObject({ code: "invoke_authority_time_window" });
  });

  test("does not accept an unpinned key or short secret", async () => {
    const command = await validInvokeCommand();
    await expect(verifyJsonCompatibilityInvokeCommand(
      {
        ...operatorEnv(),
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_KID: "different-key",
      },
      command,
      INVOKER_VERSION_ID,
      NOW_MS,
    )).rejects.toMatchObject({ code: "invalid_invoke_authority" });
    await expect(verifyJsonCompatibilityInvokeCommand(
      {
        ...operatorEnv(),
        JSON_COMPATIBILITY_INVOKER_OPERATOR_CURRENT_SECRET: "short",
      },
      command,
      INVOKER_VERSION_ID,
      NOW_MS,
    )).rejects.toMatchObject({ code: "invalid_invoke_authority" });
  });

  test("uses a fresh digest-bound authority for read-only status queries", async () => {
    const query = await validStatusQuery();
    const verified = await verifyJsonCompatibilityInvocationStatusQuery(
      statusOperatorEnv(),
      query,
      INVOKER_VERSION_ID,
      NOW_MS,
    );
    expect(verified.query).toEqual(query);
    expect(verified.authority).toMatchObject({
      keyId: STATUS_OPERATOR_KEY_ID,
      credentialIdSha256: STATUS_OPERATOR_CREDENTIAL_ID_SHA256,
      statusQueryIdSha256: query.subject.statusQueryIdSha256,
      issuedAt: query.authority.claims.issuedAt,
      expiresAt: query.authority.claims.expiresAt,
    });

    const substituted = {
      ...query,
      subject: {
        ...query.subject,
        target: {
          ...query.subject.target,
          campaignIdSha256: "f1".repeat(32),
        },
      },
    };
    await expect(verifyJsonCompatibilityInvocationStatusQuery(
      statusOperatorEnv(),
      substituted,
      INVOKER_VERSION_ID,
      NOW_MS,
    )).rejects.toMatchObject({ code: "status_authority_binding_mismatch" });
    await expect(verifyJsonCompatibilityInvocationStatusQuery(
      statusOperatorEnv(),
      query,
      INVOKER_VERSION_ID,
      NOW_MS + 31_000,
    )).rejects.toMatchObject({ code: "status_authority_time_window" });
  });
});
