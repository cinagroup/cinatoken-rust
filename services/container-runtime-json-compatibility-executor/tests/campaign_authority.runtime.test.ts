import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import type { JsonCompatibilityCampaignAuthority } from "../src/campaign_authority";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  type JsonCompatibilityPhaseOrdinal,
} from "../src/protocol";

declare global {
  namespace Cloudflare {
    interface Env {
      JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY:
        DurableObjectNamespace<JsonCompatibilityCampaignAuthority>;
    }
  }
}

const BASE_TIME = 1_800_000_000;

function digest(character: string): string {
  return character.repeat(64);
}

function beginCommand(
  campaignIdSha256: string,
  permitIdSha256: string,
  ordinal: JsonCompatibilityPhaseOrdinal,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-lease-begin-v1" as const,
    campaignIdSha256,
    campaignBindingSha256: digest("b"),
    planDigestSha256: digest("c"),
    permitIdSha256,
    permitSubjectSha256: digest("d"),
    permitEnvelopeSha256: digest("e"),
    permitExpiresAt: BASE_TIME + 600,
    phaseOrdinal: ordinal,
    phaseId: JSON_COMPATIBILITY_PHASE_IDS[ordinal - 1],
    phaseExecutionId: `phase-execution-${ordinal}`,
    leaseIdSha256: permitIdSha256,
    executorVersionId: "executor-version-runtime-test",
    acquiredAt: BASE_TIME + ordinal,
    ...overrides,
  };
}

function completeCommand(
  campaignIdSha256: string,
  permitIdSha256: string,
  ordinal: JsonCompatibilityPhaseOrdinal,
) {
  return {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-campaign-lease-complete-v1" as const,
    campaignIdSha256,
    permitIdSha256,
    phaseOrdinal: ordinal,
    phaseExecutionId: `phase-execution-${ordinal}`,
    leaseIdSha256: permitIdSha256,
    receiptSha256: digest("f"),
    completedAt: BASE_TIME + 100 + ordinal,
  };
}

function stub(campaignIdSha256: string) {
  return env.JSON_COMPATIBILITY_CAMPAIGN_AUTHORITY.getByName(
    campaignIdSha256,
  );
}

describe("JSON compatibility campaign SQLite Durable Object", () => {
  test("serializes concurrent acquisition and persists permit replay denial", async () => {
    const campaignIdSha256 = digest("1");
    let authority = stub(campaignIdSha256);
    const [left, right] = await Promise.all([
      authority.beginPhase(beginCommand(campaignIdSha256, digest("2"), 1)),
      authority.beginPhase(beginCommand(campaignIdSha256, digest("3"), 1)),
    ]);
    const accepted = [left, right].find((result) => result.ok);
    const denied = [left, right].find((result) => !result.ok);
    expect(accepted?.ok).toBe(true);
    expect(denied).toEqual({
      ok: false,
      error: { code: "campaign_lease_active" },
    });

    const acceptedPermit = accepted?.ok
      ? accepted.receipt.permitIdSha256
      : "";
    await evictDurableObject(authority);
    authority = stub(campaignIdSha256);
    await expect(authority.beginPhase(
      beginCommand(campaignIdSha256, acceptedPermit, 1),
    )).resolves.toEqual({
      ok: false,
      error: { code: "campaign_permit_replayed" },
    });

    const rows = await runInDurableObject(authority, (_instance, state) => ({
      campaign: state.storage.sql.exec<{ status: string; active: string }>(
        `SELECT status, active_permit_id_sha256 AS active
           FROM json_compatibility_campaign_state`,
      ).one(),
      permits: state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM json_compatibility_campaign_permits`,
      ).one(),
    }));
    expect(rows.campaign).toEqual({ status: "active", active: acceptedPermit });
    expect(rows.permits.count).toBe(1);
  });

  test("enforces exact phase order and makes a failed campaign terminal", async () => {
    const campaignIdSha256 = digest("4");
    const authority = stub(campaignIdSha256);
    const permit1 = digest("5");
    expect((await authority.beginPhase(
      beginCommand(campaignIdSha256, permit1, 1),
    )).ok).toBe(true);
    expect(await authority.completePhase(
      completeCommand(campaignIdSha256, permit1, 1),
    )).toEqual({ ok: true, status: "phase_completed" });

    expect(await authority.beginPhase(
      beginCommand(campaignIdSha256, digest("6"), 3),
    )).toEqual({
      ok: false,
      error: { code: "campaign_phase_order_conflict" },
    });

    const permit2 = digest("7");
    expect((await authority.beginPhase(
      beginCommand(campaignIdSha256, permit2, 2),
    )).ok).toBe(true);
    expect(await authority.failPhase({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-campaign-lease-fail-v1",
      campaignIdSha256,
      permitIdSha256: permit2,
      phaseOrdinal: 2,
      phaseExecutionId: "phase-execution-2",
      leaseIdSha256: permit2,
      failureCode: "invalid_probe_result",
      failedAt: BASE_TIME + 202,
    })).toEqual({ ok: true, status: "campaign_failed" });
    expect(await authority.beginPhase(
      beginCommand(campaignIdSha256, digest("8"), 3),
    )).toEqual({
      ok: false,
      error: { code: "campaign_terminal" },
    });
  });

  test("completes exactly four phases and rejects post-terminal work", async () => {
    const campaignIdSha256 = digest("9");
    const authority = stub(campaignIdSha256);
    const permits = [digest("a"), digest("b"), digest("c"), digest("d")];
    for (let index = 0; index < permits.length; index += 1) {
      const ordinal = (index + 1) as JsonCompatibilityPhaseOrdinal;
      const permit = permits[index] as string;
      const acquired = await authority.beginPhase(
        beginCommand(campaignIdSha256, permit, ordinal),
      );
      expect(acquired.ok).toBe(true);
      const completed = await authority.completePhase(
        completeCommand(campaignIdSha256, permit, ordinal),
      );
      expect(completed).toEqual({
        ok: true,
        status: ordinal === 4 ? "campaign_completed" : "phase_completed",
      });
    }
    expect(await authority.beginPhase(
      beginCommand(campaignIdSha256, digest("e"), 4),
    )).toEqual({
      ok: false,
      error: { code: "campaign_terminal" },
    });
  });

  test("pins the first campaign binding for the object lifetime", async () => {
    const campaignIdSha256 = digest("f");
    const authority = stub(campaignIdSha256);
    const permit1 = digest("0");
    expect((await authority.beginPhase(
      beginCommand(campaignIdSha256, permit1, 1),
    )).ok).toBe(true);
    expect(await authority.completePhase(
      completeCommand(campaignIdSha256, permit1, 1),
    )).toEqual({ ok: true, status: "phase_completed" });
    expect(await authority.beginPhase(beginCommand(
      campaignIdSha256,
      digest("1"),
      2,
      { campaignBindingSha256: digest("2") },
    ))).toEqual({
      ok: false,
      error: { code: "campaign_binding_conflict" },
    });
  });
});
