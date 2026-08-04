import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import type { JsonCompatibilityPermitIssuanceAuthority } from "../src/issuance_authority";
import {
  JSON_COMPATIBILITY_PHASE_IDS,
  type JsonCompatibilityPhaseOrdinal,
} from "../../container-runtime-json-compatibility-executor/src/protocol";

declare global {
  namespace Cloudflare {
    interface Env {
      JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY:
        DurableObjectNamespace<JsonCompatibilityPermitIssuanceAuthority>;
    }
  }
}

const BASE_TIME = 1_800_100_000;

function digest(value: string): string {
  return value.repeat(64);
}

function offsetHex(value: string, offset: number): string {
  const alphabet = "0123456789abcdef";
  const index = alphabet.indexOf(value);
  if (index < 0) throw new Error("test salt must be hexadecimal");
  return alphabet[(index + offset) % alphabet.length] as string;
}

function command(
  campaignIdSha256: string,
  ordinal: JsonCompatibilityPhaseOrdinal,
  salt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1 as const,
    contract:
      "cinatoken-container-runtime-json-compatibility-permit-issuance-record-v1" as const,
    campaignIdSha256,
    campaignBindingSha256: digest("b"),
    planDigestSha256: digest("c"),
    phaseOrdinal: ordinal,
    phaseId: JSON_COMPATIBILITY_PHASE_IDS[ordinal - 1],
    phaseExecutionId: `phase-${ordinal}-${salt}`,
    issueIntentSha256: digest(salt),
    authorityRequestIdSha256: digest(offsetHex(salt, 1)),
    permitIdSha256: digest(offsetHex(salt, 2)),
    permitSubjectSha256: digest(offsetHex(salt, 3)),
    permitEnvelopeSha256: digest(offsetHex(salt, 4)),
    issuerVersionId: "issuer-version-runtime-test",
    issuedAt: BASE_TIME + ordinal,
    expiresAt: BASE_TIME + 300 + ordinal,
    ...overrides,
  };
}

function stub(campaignIdSha256: string) {
  return env.JSON_COMPATIBILITY_PERMIT_ISSUANCE_AUTHORITY.getByName(
    campaignIdSha256,
  );
}

describe("JSON compatibility permit issuance SQLite authority", () => {
  test("admits one concurrent phase issuance and rejects replay after eviction", async () => {
    const campaign = digest("1");
    let authority = stub(campaign);
    const [left, right] = await Promise.all([
      authority.recordIssuance(command(campaign, 1, "2")),
      authority.recordIssuance(command(campaign, 1, "7")),
    ]);
    expect([left, right].filter((result) => result.ok)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "permit_issuance_replayed" } },
    ]);

    const accepted = [left, right].find((result) => result.ok);
    await evictDurableObject(authority);
    authority = stub(campaign);
    expect(accepted?.ok).toBe(true);
    if (!accepted?.ok) throw new Error("missing accepted issuance");
    await expect(authority.recordIssuance(command(
      campaign,
      1,
      "9",
      { permitIdSha256: accepted.receipt.permitIdSha256 },
    ))).resolves.toEqual({
      ok: false,
      error: { code: "permit_issuance_replayed" },
    });
  });

  test("pins campaign identity and enforces all four issuance ordinals", async () => {
    const campaign = digest("a");
    const authority = stub(campaign);
    await expect(authority.recordIssuance(command(campaign, 2, "2")))
      .resolves.toEqual({
        ok: false,
        error: { code: "permit_issuance_phase_conflict" },
      });
    for (let index = 0; index < 4; index += 1) {
      const ordinal = (index + 1) as JsonCompatibilityPhaseOrdinal;
      const result = await authority.recordIssuance(
        command(campaign, ordinal, String(index + 2)),
      );
      expect(result.ok).toBe(true);
    }
    await expect(authority.recordIssuance(command(
      campaign,
      4,
      "8",
      { campaignBindingSha256: digest("d") },
    ))).resolves.toEqual({
      ok: false,
      error: { code: "permit_issuance_replayed" },
    });
  });
});
