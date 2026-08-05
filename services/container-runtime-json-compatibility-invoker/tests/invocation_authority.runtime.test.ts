import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  sha256Hex,
} from "../../container-controller/src/json_compatibility_probe";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  type JsonCompatibilityPhaseOrdinal,
} from "../../container-runtime-json-compatibility-executor/src/protocol";
import type { JsonCompatibilityInvocationAuthority } from "../src/invocation_authority";

declare global {
  namespace Cloudflare {
    interface Env {
      JSON_COMPATIBILITY_INVOCATION_AUTHORITY:
        DurableObjectNamespace<JsonCompatibilityInvocationAuthority>;
    }
  }
}

const BASE_TIME = 1_800_200_000;

function digest(value: string): string {
  return value.repeat(64);
}

function offsetHex(value: string, offset: number): string {
  const alphabet = "0123456789abcdef";
  const index = alphabet.indexOf(value);
  if (index < 0) throw new Error("test salt must be hexadecimal");
  return alphabet[(index + offset) % alphabet.length] as string;
}

function beginCommand(
  campaignIdSha256: string,
  ordinal: JsonCompatibilityPhaseOrdinal,
  salt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-begin-v1" as const,
    campaignIdSha256,
    campaignBindingSha256: digest("b"),
    planDigestSha256: digest("c"),
    phaseOrdinal: ordinal,
    phaseId: JSON_COMPATIBILITY_PHASE_IDS[ordinal - 1],
    phaseExecutionId: `phase-${ordinal}-${salt}`,
    commandIdSha256: digest(salt),
    commandSubjectSha256: digest(offsetHex(salt, 1)),
    commandAuthorityEnvelopeSha256: digest(offsetHex(salt, 2)),
    issueIntentSha256: digest(offsetHex(salt, 3)),
    topologyReadbackSha256: digest("d"),
    beforeContextSha256: digest("e"),
    attemptIdSha256: digest(offsetHex(salt, 4)),
    invokerVersionId: "invoker-version-runtime-test",
    startedAt: BASE_TIME + ordinal,
    ...overrides,
  };
}

async function completeCommand(
  begin: ReturnType<typeof beginCommand>,
  salt: string,
) {
  const invocationBodyJson = canonicalJson({ salt });
  return {
    schemaVersion: 2 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-complete-v2" as const,
    campaignIdSha256: begin.campaignIdSha256,
    phaseOrdinal: begin.phaseOrdinal,
    phaseExecutionId: begin.phaseExecutionId,
    commandIdSha256: begin.commandIdSha256,
    attemptIdSha256: begin.attemptIdSha256,
    permitIdSha256: digest(salt),
    permitIssueReceiptSha256: digest(offsetHex(salt, 1)),
    executorReceiptSha256: digest(offsetHex(salt, 2)),
    invocationBodySha256: await sha256Hex(invocationBodyJson),
    invocationBodyJson,
    completedAt: BASE_TIME + 100 + begin.phaseOrdinal,
  };
}

function stub(campaignIdSha256: string) {
  return env.JSON_COMPATIBILITY_INVOCATION_AUTHORITY.getByName(
    campaignIdSha256,
  );
}

function statusQuery(begin: ReturnType<typeof beginCommand>) {
  return {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-invocation-attempt-status-query-v1" as const,
    campaignIdSha256: begin.campaignIdSha256,
    planDigestSha256: begin.planDigestSha256,
    phaseOrdinal: begin.phaseOrdinal,
    phaseId: begin.phaseId,
    phaseExecutionId: begin.phaseExecutionId,
    commandIdSha256: begin.commandIdSha256,
    invokerVersionId: begin.invokerVersionId,
  };
}

describe("JSON compatibility invocation SQLite authority", () => {
  test("serializes concurrent starts and rejects replay after eviction", async () => {
    const campaign = digest("1");
    let authority = stub(campaign);
    const leftCommand = beginCommand(campaign, 1, "2");
    const rightCommand = beginCommand(campaign, 1, "7");
    const [left, right] = await Promise.all([
      authority.beginAttempt(leftCommand),
      authority.beginAttempt(rightCommand),
    ]);
    const accepted = [left, right].find((result) => result.ok);
    const denied = [left, right].find((result) => !result.ok);
    expect(accepted?.ok).toBe(true);
    expect(denied).toEqual({
      ok: false,
      error: { code: "invocation_attempt_active" },
    });

    const acceptedCommand = left.ok ? leftCommand : rightCommand;
    await evictDurableObject(authority);
    authority = stub(campaign);
    await expect(authority.beginAttempt(acceptedCommand)).resolves.toEqual({
      ok: false,
      error: { code: "invocation_attempt_replayed" },
    });

    const rows = await runInDurableObject(authority, (_instance, state) => ({
      campaign: state.storage.sql.exec<{ status: string; active: string }>(
        `SELECT status, active_command_id_sha256 AS active
           FROM json_compatibility_invocation_campaign`,
      ).one(),
      attempts: state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM json_compatibility_invocation_attempts",
      ).one(),
    }));
    expect(rows.campaign).toEqual({
      status: "active",
      active: acceptedCommand.commandIdSha256,
    });
    expect(rows.attempts.count).toBe(1);
  });

  test("enforces exact four-phase order and emits digest-bound completion receipts", async () => {
    const campaign = digest("3");
    const authority = stub(campaign);
    await expect(authority.beginAttempt(
      beginCommand(campaign, 2, "4"),
    )).resolves.toEqual({
      ok: false,
      error: { code: "invocation_phase_order_conflict" },
    });

    const salts = ["4", "6", "8", "a"];
    const completionSalts = ["5", "7", "9", "b"];
    for (let index = 0; index < salts.length; index += 1) {
      const ordinal = (index + 1) as JsonCompatibilityPhaseOrdinal;
      const command = beginCommand(campaign, ordinal, salts[index] as string);
      const started = await authority.beginAttempt(command);
      expect(started.ok).toBe(true);
      const completed = await authority.completeAttemptV2(
        await completeCommand(command, completionSalts[index] as string),
      );
      expect(completed.ok).toBe(true);
      if (!completed.ok || completed.receipt === undefined) {
        throw new Error("missing completion receipt");
      }
      expect(completed.status).toBe(
        ordinal === 4
          ? "invocation_campaign_completed"
          : "invocation_phase_completed",
      );
      const { receiptSha256, ...subject } = completed.receipt;
      expect(receiptSha256).toBe(await sha256Hex(canonicalJson(subject)));
      expect(completed.receipt.campaignTerminal).toBe(ordinal === 4);
    }

    await expect(authority.beginAttempt(
      beginCommand(campaign, 4, "c"),
    )).resolves.toEqual({
      ok: false,
      error: { code: "invocation_campaign_terminal" },
    });
  });

  test("pins campaign identity and makes a failed attempt terminal", async () => {
    const campaign = digest("d");
    const authority = stub(campaign);
    const first = beginCommand(campaign, 1, "1");
    expect((await authority.beginAttempt(first)).ok).toBe(true);
    expect(await authority.failAttempt({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-invocation-attempt-fail-v1",
      campaignIdSha256: campaign,
      phaseOrdinal: 1,
      phaseExecutionId: first.phaseExecutionId,
      commandIdSha256: first.commandIdSha256,
      attemptIdSha256: first.attemptIdSha256,
      failureCode: "permit_issuer_unavailable",
      failedAt: BASE_TIME + 200,
    })).toEqual({ ok: true, status: "invocation_campaign_failed" });
    await expect(authority.getAttemptStatus(statusQuery(first))).resolves
      .toMatchObject({
        ok: true,
        status: "failed",
        failureCode: "permit_issuer_unavailable",
        failedAt: BASE_TIME + 200,
      });

    await expect(authority.beginAttempt(
      beginCommand(campaign, 2, "2"),
    )).resolves.toEqual({
      ok: false,
      error: { code: "invocation_campaign_terminal" },
    });
  });

  test("recovers active and completed status with the canonical body after eviction", async () => {
    const campaign = digest("e");
    let authority = stub(campaign);
    const command = beginCommand(campaign, 1, "3");
    expect((await authority.beginAttempt(command)).ok).toBe(true);
    await expect(authority.getAttemptStatus(statusQuery(command))).resolves
      .toMatchObject({ ok: true, status: "active" });

    const completionCommand = await completeCommand(command, "4");
    expect((await authority.completeAttemptV2(completionCommand)).ok).toBe(true);
    await evictDurableObject(authority);
    authority = stub(campaign);
    const recovered = await authority.getAttemptStatus(statusQuery(command));
    expect(recovered).toMatchObject({
      ok: true,
      status: "completed",
      invocationBodyJson: completionCommand.invocationBodyJson,
    });
    if (!recovered.ok || recovered.status !== "completed") {
      throw new Error("missing completed status");
    }
    expect(recovered.completion.invocationBodySha256).toBe(
      completionCommand.invocationBodySha256,
    );
    await expect(authority.getAttemptStatus({
      ...statusQuery(command),
      planDigestSha256: digest("f"),
    })).resolves.toEqual({
      ok: false,
      error: { code: "invocation_attempt_conflict" },
    });
  });

  test("keeps v1 completion compatible and reports its receipt as unavailable", async () => {
    const campaign = digest("f");
    const authority = stub(campaign);
    const command = beginCommand(campaign, 1, "4");
    expect((await authority.beginAttempt(command)).ok).toBe(true);
    const v2 = await completeCommand(command, "5");
    const { invocationBodyJson: _invocationBodyJson, ...completionFields } = v2;
    const legacy = {
      ...completionFields,
      schemaVersion: 1 as const,
      contract:
        "cinatoken-container-runtime-json-compatibility-invocation-attempt-complete-v1" as const,
    };
    expect((await authority.completeAttempt(legacy)).ok).toBe(true);
    await expect(authority.getAttemptStatus(statusQuery(command))).resolves
      .toMatchObject({
        ok: true,
        status: "completed_receipt_unavailable",
      });
  });
});
