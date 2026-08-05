import { describe, expect, test } from "vitest";

import {
  sourceAuthenticationBundleKey,
  validateJsonCompatibilitySourceAuthenticationBundle,
} from "../../../tools/container_runtime_json_compatibility_source_authentication.mjs";
import {
  createSourceAuthenticationFixture,
} from "../../../tests/fixtures/container-runtime-json-compatibility-source-authentication.mjs";

describe("source authentication bundle protocol", () => {
  test("separates release evidence from campaign-closure evidence", async () => {
    const release = await createSourceAuthenticationFixture();
    const closure = await createSourceAuthenticationFixture({
      transitionId: "disarm-execution-retain-status-caller-to-callee",
      operationSeed: "source-authentication-closure",
    });
    expect(validateJsonCompatibilitySourceAuthenticationBundle(
      release.sourceAuthenticationRequest,
      release.bundle,
      { now: release.now },
    )).toEqual(release.bundle);
    expect(validateJsonCompatibilitySourceAuthenticationBundle(
      closure.sourceAuthenticationRequest,
      closure.bundle,
      { now: closure.now },
    )).toEqual(closure.bundle);
    expect(release.sourceAuthenticationRequest.profile).toBe("release-v1");
    expect(release.bundle.phaseSourceManifest).toBeNull();
    expect(closure.sourceAuthenticationRequest.profile)
      .toBe("campaign-closure-v1");
    expect(closure.bundle.phaseSourceManifest).toMatchObject({
      schemaVersion: 3,
      sourceManifestSha256:
        closure.sourceAuthenticationRequest.sourceEvidence
          .phaseSourceManifestSha256,
    });
    expect(release.bundle.artifactInventoryReadback.artifactCount).toBe(18);
    expect(release.bundle.accountBindingInventory.campaignServiceNames)
      .toHaveLength(7);
  });

  test("rejects operation substitution and nested inventory drift", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const other = await createSourceAuthenticationFixture({
      operationSeed: "different-source-operation",
    });
    expect(() => validateJsonCompatibilitySourceAuthenticationBundle(
      other.sourceAuthenticationRequest,
      fixture.bundle,
      { now: fixture.now },
    )).toThrow();

    const drifted = structuredClone(fixture.bundle);
    drifted.artifactInventoryReadback.artifacts[0].versionId =
      "detached-version";
    expect(() => validateJsonCompatibilitySourceAuthenticationBundle(
      fixture.sourceAuthenticationRequest,
      drifted,
      { now: fixture.now },
    )).toThrow();
  });

  test("derives a fixed R2 key solely from the envelope digest", async () => {
    const fixture = await createSourceAuthenticationFixture();
    expect(sourceAuthenticationBundleKey(
      fixture.sourceSignatureEnvelopeSha256,
    )).toBe(fixture.bundleKey);
    expect(fixture.bundleKey).toMatch(
      /^container-runtime\/json-compatibility\/source-authentication\/v2\/sha256\/bundles\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/,
    );
    expect(() => sourceAuthenticationBundleKey(
      fixture.sourceSignatureEnvelopeSha256,
      "../caller-controlled",
    )).toThrow();
  });

  test("rejects an archive locked before its evidence was observed", async () => {
    const now = 1_786_000_000;
    await expect(createSourceAuthenticationFixture({
      now,
      operationSeed: "source-archive-causal-order",
      archiveLockedAt: now - 300,
    })).rejects.toThrow(/source_archive_causal_order_mismatch/);
  });

  test("rejects stale archive readback and insufficient remaining retention", async () => {
    const now = 1_786_000_000;
    await expect(createSourceAuthenticationFixture({
      now,
      operationSeed: "source-archive-stale-readback",
      evidenceObservedAt: now - 4_000,
      archiveLockedAt: now - 3_900,
      archiveReadbackAt: now - 3_601,
    })).rejects.toThrow(/source_archive_readback_window_mismatch/);

    await expect(createSourceAuthenticationFixture({
      now,
      operationSeed: "source-archive-short-remaining-retention",
      archiveRetainUntil: now + 365 * 24 * 60 * 60 - 1,
    })).rejects.toThrow(/source_archive_remaining_retention_invalid/);
  });
});
