import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const placeholderExternalWormPolicySha256 = "0".repeat(64);
const sourceAuthenticationV3KeyPrefix =
  "container-runtime/json-compatibility/source-authentication/v3/sha256";

describe("source verifier deployment boundary", () => {
  test.each(["wrangler.local.jsonc", "wrangler.staging.jsonc"])(
    "%s is private, default-off, and local-R2-only",
    async (file) => {
      const config = JSON.parse(await readFile(path.join(root, file), "utf8"));
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.routes).toBeUndefined();
      expect({
        enabled: config.vars.JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED,
        externalWormPolicySha256:
          config.vars
            .JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_SHA256,
      }).toEqual({
        enabled: "false",
        externalWormPolicySha256: placeholderExternalWormPolicySha256,
      });
      expect(config.vars.JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX).toBe(
        sourceAuthenticationV3KeyPrefix,
      );
      expect(config.vars).toMatchObject({
        JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED: "false",
        JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: "false",
        JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_SHA256:
          placeholderExternalWormPolicySha256,
        JSON_COMPATIBILITY_SOURCE_VERIFIER_PROFILE_VERSION: "1",
        JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX:
          sourceAuthenticationV3KeyPrefix,
        JSON_COMPATIBILITY_SOURCE_CURRENT_KID: "",
        JSON_COMPATIBILITY_SOURCE_CURRENT_SPKI_SHA256: "",
        JSON_COMPATIBILITY_SOURCE_PREVIOUS_KID: "",
        JSON_COMPATIBILITY_SOURCE_PREVIOUS_SPKI_SHA256: "",
        JSON_COMPATIBILITY_SOURCE_PREVIOUS_ACCEPT_UNTIL: "",
      });
      expect(config.r2_buckets).toEqual([
        expect.objectContaining({
          binding: "SOURCE_AUTHENTICATION_BUCKET",
          remote: false,
        }),
      ]);
    },
  );

  test("exports named RPC only and has no R2 write or list path", async () => {
    const index = await readFile(path.join(root, "src/index.ts"), "utf8");
    const verifier = await readFile(path.join(root, "src/verifier.ts"), "utf8");
    expect(index).toMatch(/extends WorkerEntrypoint/u);
    expect(index).toMatch(/authenticateTransitionSource/u);
    expect(index).toMatch(
      /export default class JsonCompatibilitySourceVerifierDefaultEntrypoint/u,
    );
    expect(index).not.toMatch(
      /export default JsonCompatibilitySourceVerifierEntrypoint/u,
    );
    expect(index).not.toMatch(/\bfetch\s*\(/u);
    expect(verifier).toMatch(/SOURCE_AUTHENTICATION_BUCKET\.head\(/u);
    expect(verifier).toMatch(/SOURCE_AUTHENTICATION_BUCKET\.get\(/u);
    expect(verifier).not.toMatch(
      /SOURCE_AUTHENTICATION_BUCKET\.(?:put|delete|list|createMultipartUpload|resumeMultipartUpload)\(/u,
    );
    expect(verifier).not.toMatch(/\bfetch\s*\(/u);
  });
});
