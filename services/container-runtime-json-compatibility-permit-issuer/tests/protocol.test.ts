import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  verifyJsonCompatibilityPhasePermit,
} from "../../container-runtime-json-compatibility-executor/src/authorization";
import {
  issueJsonCompatibilityPhasePermit,
  JsonCompatibilityPermitIssuerError,
} from "../src/protocol";
import {
  AUTHORITY_SECRET,
  NOW_MS,
  PERMIT_KEY_ID,
  PERMIT_SPKI_SHA256,
  encodeBase64url,
  issuerEnv,
  validIssueRequest,
  validIntent,
  PERMIT_SPKI,
} from "./fixtures";

async function successfulIssuance(input: unknown): Promise<unknown> {
  const value = input as Record<string, unknown>;
  const subject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-receipt-v1",
    status: "permit_issuance_recorded",
    campaignIdSha256: value.campaignIdSha256,
    campaignBindingSha256: value.campaignBindingSha256,
    planDigestSha256: value.planDigestSha256,
    phaseOrdinal: value.phaseOrdinal,
    phaseId: value.phaseId,
    phaseExecutionId: value.phaseExecutionId,
    issueIntentSha256: value.issueIntentSha256,
    authorityRequestIdSha256: value.authorityRequestIdSha256,
    permitIdSha256: value.permitIdSha256,
    permitSubjectSha256: value.permitSubjectSha256,
    permitEnvelopeSha256: value.permitEnvelopeSha256,
    issuerVersionId: value.issuerVersionId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    onePermitPerPhasePersisted: true,
    phaseIssuanceOrderEnforced: true,
    ambiguousRetryRejected: true,
  };
  return {
    ok: true,
    receipt: {
      ...subject,
      receiptSha256: await sha256Hex(canonicalJson(subject)),
    },
  };
}

describe("JSON compatibility phase permit issuer", () => {
  test("authenticates, signs, self-verifies, and records one exact permit", async () => {
    let recorded: unknown;
    const env = issuerEnv(async (input) => {
      recorded = input;
      return await successfulIssuance(input);
    });
    const request = await validIssueRequest();
    const receipt = await issueJsonCompatibilityPhasePermit(env, request, NOW_MS);

    expect(receipt.status).toBe("phase_permit_issued");
    expect(receipt.issueIntent).toEqual(request.intent);
    expect(receipt.issueIntentSha256).toBe(
      await sha256Hex(canonicalJson(request.intent)),
    );
    expect(receipt.permitEnvelope.subject.executor.versionId).toBe(
      "executor-version-001",
    );
    expect(receipt.permitEnvelope.subject.keyId).toBe(PERMIT_KEY_ID);
    expect(recorded).toMatchObject({
      campaignIdSha256: request.intent.execution.campaignIdSha256,
      phaseOrdinal: 1,
      permitIdSha256: receipt.permitEnvelope.subject.permitIdSha256,
    });

    await expect(verifyJsonCompatibilityPhasePermit(
      {
        JSON_COMPATIBILITY_PERMIT_ISSUER:
          "cinatoken-json-compatibility-permit-issuer-staging",
        JSON_COMPATIBILITY_PERMIT_AUDIENCE:
          "cinatoken-container-runtime-json-compatibility-executor-staging",
        JSON_COMPATIBILITY_PERMIT_KEY_ID: PERMIT_KEY_ID,
        JSON_COMPATIBILITY_PERMIT_SPKI_SHA256: PERMIT_SPKI_SHA256,
        JSON_COMPATIBILITY_PERMIT_SPKI_BASE64URL: encodeBase64url(PERMIT_SPKI),
      },
      {
        ...request.intent.execution,
        authorization: receipt.permitEnvelope,
      },
      "executor-version-001",
      NOW_MS,
    )).resolves.toMatchObject({
      permitIdSha256: receipt.permitEnvelope.subject.permitIdSha256,
      signerSpkiSha256: PERMIT_SPKI_SHA256,
    });
  });

  test("rejects disabled execution before touching signing or authority state", async () => {
    let called = false;
    const env = issuerEnv(async () => {
      called = true;
      return {};
    });
    env.JSON_COMPATIBILITY_PERMIT_ISSUER_ENABLED = "false";
    delete env.JSON_COMPATIBILITY_PERMIT_PKCS8_BASE64URL;
    await expect(issueJsonCompatibilityPhasePermit(
      env,
      await validIssueRequest(),
      NOW_MS,
    )).rejects.toMatchObject({ code: "permit_issuer_disabled" });
    expect(called).toBe(false);
  });

  test("rejects authority tampering and intent substitution", async () => {
    const env = issuerEnv(successfulIssuance);
    const tampered = await validIssueRequest();
    tampered.authority.signatureBase64url = `${tampered.authority.signatureBase64url.slice(0, -1)}A`;
    await expect(issueJsonCompatibilityPhasePermit(
      env,
      tampered,
      NOW_MS,
    )).rejects.toBeInstanceOf(JsonCompatibilityPermitIssuerError);

    const substituted = await validIssueRequest();
    substituted.intent = validIntent("mixed-n-n-minus-one");
    await expect(issueJsonCompatibilityPhasePermit(
      env,
      substituted,
      NOW_MS,
    )).rejects.toMatchObject({ code: "permit_issue_binding_mismatch" });
  });

  test("rejects stale authority and unsafe permit windows", async () => {
    const env = issuerEnv(successfulIssuance);
    await expect(issueJsonCompatibilityPhasePermit(
      env,
      await validIssueRequest(),
      NOW_MS + 61_000,
    )).rejects.toMatchObject({ code: "permit_issue_authority_time_window" });

    const intent = validIntent();
    intent.expiresAt = intent.issuedAt + 100;
    await expect(issueJsonCompatibilityPhasePermit(
      env,
      await validIssueRequest(intent),
      NOW_MS,
    )).rejects.toMatchObject({ code: "permit_issue_binding_mismatch" });
  });

  test("fails closed for signer or issuance authority drift", async () => {
    const signerDrift = issuerEnv(successfulIssuance);
    signerDrift.JSON_COMPATIBILITY_PERMIT_SPKI_SHA256 = "dd".repeat(32);
    await expect(issueJsonCompatibilityPhasePermit(
      signerDrift,
      await validIssueRequest(),
      NOW_MS,
    )).rejects.toMatchObject({ code: "permit_signer_unavailable" });

    const conflict = issuerEnv(() => Promise.resolve({
      ok: false,
      error: { code: "permit_issuance_replayed" },
    }));
    await expect(issueJsonCompatibilityPhasePermit(
      conflict,
      await validIssueRequest(),
      NOW_MS,
    )).rejects.toMatchObject({ code: "permit_issuance_conflict" });
  });

  test("does not accept a short authority secret", async () => {
    const env = issuerEnv(successfulIssuance);
    env.JSON_COMPATIBILITY_ISSUER_AUTHORITY_CURRENT_SECRET = "short";
    await expect(issueJsonCompatibilityPhasePermit(
      env,
      await validIssueRequest(),
      NOW_MS,
    )).rejects.toMatchObject({ code: "invalid_permit_issue_authority" });
    expect(AUTHORITY_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});
