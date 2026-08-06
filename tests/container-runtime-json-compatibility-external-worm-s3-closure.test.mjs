import { describe, expect, test } from "bun:test";

import {
  JsonCompatibilityExternalWormS3ClosureError,
  buildJsonCompatibilityExternalWormS3Closure,
  deriveJsonCompatibilityExternalWormS3ArchiveIdentities,
} from "../tools/container_runtime_json_compatibility_external_worm_s3_closure.mjs";
import {
  sha256JsonCompatibilityExternalWormS3Text,
} from "../tools/container_runtime_json_compatibility_external_worm_s3_observation.mjs";

describe("external WORM S3 to C2 closure", () => {
  test("derives order-independent identities bound to the exact S3 target", async () => {
    const bucketNameSha256 = await digest("bucket");
    const expectedBucketOwnerSha256 = await digest("owner");
    const firstKey = await digest("object-a");
    const secondKey = await digest("object-b");
    const target = {
      provider: "amazon-s3",
      region: "ap-southeast-1",
      bucketNameSha256,
      expectedBucketOwnerSha256,
      objectKeySha256s: [secondKey, firstKey],
    };

    const identity = await deriveJsonCompatibilityExternalWormS3ArchiveIdentities(
      target,
    );
    const reordered = await deriveJsonCompatibilityExternalWormS3ArchiveIdentities({
      ...target,
      objectKeySha256s: [firstKey, secondKey],
    });
    const otherRegion = await deriveJsonCompatibilityExternalWormS3ArchiveIdentities({
      ...target,
      region: "us-east-1",
    });

    expect(identity).toEqual(reordered);
    expect(identity.objectKeySha256s).toEqual([firstKey, secondKey].sort());
    expect(identity.backendIdentitySha256).not.toBe(
      otherRegion.backendIdentitySha256,
    );
    expect(identity.namespaceIdentitySha256).not.toBe(
      otherRegion.namespaceIdentitySha256,
    );
  });

  test("rejects duplicate keys and incomplete C2 evidence with typed failures", async () => {
    const key = await digest("object");
    const target = {
      provider: "amazon-s3",
      region: "ap-southeast-1",
      bucketNameSha256: await digest("bucket"),
      expectedBucketOwnerSha256: await digest("owner"),
      objectKeySha256s: [key, key],
    };

    await expect(
      deriveJsonCompatibilityExternalWormS3ArchiveIdentities(target),
    ).rejects.toBeInstanceOf(JsonCompatibilityExternalWormS3ClosureError);

    await expect(buildJsonCompatibilityExternalWormS3Closure({
      archiveEvidence: {},
      target: { ...target, objectKeySha256s: [key] },
      writerObservations: [],
      readbackObservations: [],
    })).rejects.toMatchObject({
      name: "JsonCompatibilityExternalWormS3ClosureError",
      code: "c2_evidence_keys_invalid",
    });
  });

  test("keeps the Worker import graph free of AWS, Node, and credential logic", async () => {
    const paths = [
      "tools/container_runtime_json_compatibility_external_worm_s3_closure.mjs",
      "tools/container_runtime_json_compatibility_external_worm_s3_observation.mjs",
    ];
    const sources = await Promise.all(paths.map((path) => Bun.file(path).text()));
    const combined = sources.join("\n");

    for (const forbidden of [
      "@aws-sdk/client-s3",
      "node:fs",
      "node:path",
      "process.env",
      "tools/lib/container_runtime_json_compatibility_external_worm_s3.mjs",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
    expect(sources[1]).not.toMatch(/^\s*import\s/m);
    expect(sources[0].match(/^\s*import\s/gm)).toHaveLength(1);
    expect(sources[0]).toContain(
      'from "./container_runtime_json_compatibility_external_worm_s3_observation.mjs"',
    );
  });
});

function digest(value) {
  return sha256JsonCompatibilityExternalWormS3Text(value);
}
