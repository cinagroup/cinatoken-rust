import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const placeholderSha256 = "0".repeat(64);
const expectedKeyPrefix =
  "container-runtime/json-compatibility/source-authentication/v3/sha256";

describe("source publisher deployment boundary", () => {
  test.each(["wrangler.local.jsonc", "wrangler.staging.jsonc"])(
    "%s is private, default-off, and points at the verifier bucket",
    async (file) => {
      const config = JSON.parse(await readFile(path.join(root, file), "utf8"));
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
      expect(config.vars).toMatchObject({
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_ENABLED: "false",
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_R2_WRITE_ENABLED: "false",
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME:
          "cinatoken-container-runtime-json-compatibility-source-publisher-staging",
        JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX: expectedKeyPrefix,
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_POLICY_SHA256:
          placeholderSha256,
        JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_IDENTITY_SHA256:
          placeholderSha256,
      });
      expect(config.r2_buckets).toEqual([
        expect.objectContaining({
          binding: "SOURCE_AUTHENTICATION_BUCKET",
          bucket_name: file.includes("staging")
            ? "cinatoken-json-compatibility-source-authentication-staging"
            : "cinatoken-json-compatibility-source-authentication-local",
          remote: false,
        }),
      ]);
    },
  );

  test("exports one named write RPC and has no R2 read/list/delete path", async () => {
    const index = await readFile(path.join(root, "src/index.ts"), "utf8");
    const publisher = await readFile(
      path.join(root, "src/publisher.ts"),
      "utf8",
    );
    expect(index).toMatch(/extends WorkerEntrypoint/u);
    expect(index).toMatch(/publishSourceBundle/u);
    expect(index).toMatch(
      /export default class JsonCompatibilitySourcePublisherDefaultEntrypoint/u,
    );
    expect(index).not.toMatch(
      /export default JsonCompatibilitySourcePublisherEntrypoint/u,
    );
    expect(index).not.toMatch(/\bfetch\s*\(/u);
    expect(publisher).toMatch(/SOURCE_AUTHENTICATION_BUCKET\.put\(/u);
    expect(publisher).toMatch(/etagDoesNotMatch:\s*"\*"/u);
    expect(publisher).not.toMatch(
      /SOURCE_AUTHENTICATION_BUCKET\.(?:head|get|delete|list|createMultipartUpload|resumeMultipartUpload)\(/u,
    );
    expect(publisher).not.toMatch(/\bfetch\s*\(/u);
  });
});
