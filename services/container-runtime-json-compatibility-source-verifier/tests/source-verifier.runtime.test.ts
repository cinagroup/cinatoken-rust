import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";

import {
  sourceAuthenticationRevocationKey,
} from "../../../tools/container_runtime_json_compatibility_source_authentication.mjs";
import type {
  JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  JsonCompatibilityDeploymentTransitionSourceAuthenticationV2,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";

interface SourceVerifierRpcBinding {
  authenticateTransitionSource(
    input: unknown,
  ): Promise<JsonCompatibilityDeploymentTransitionSourceAuthenticationV2>;
}

interface RuntimeTestEnv {
  readonly SOURCE_AUTHENTICATION_BUCKET: R2Bucket;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER_NAMED: SourceVerifierRpcBinding;
  readonly TEST_SOURCE_AUTHENTICATION_REQUEST: string;
  readonly TEST_SOURCE_AUTHENTICATION_BUNDLE: string;
  readonly TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY: string;
  readonly TEST_SOURCE_AUTHENTICATION_BUNDLE_SHA256: string;
  readonly TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256: string;
  readonly TEST_SOURCE_SIGNER_SPKI_SHA256: string;
}

const runtimeEnv = env as unknown as RuntimeTestEnv;

afterEach(async () => {
  await reset();
});

describe("source verifier named RPC with real R2", () => {
  test("authenticates a canonical create-once bundle without mutating it", async () => {
    const request = sourceRequest();
    await putBundle();
    const before = await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.head(
      runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY,
    );
    const proof = await runtimeEnv.JSON_COMPATIBILITY_SOURCE_VERIFIER_NAMED
      .authenticateTransitionSource(request);
    expect(proof).toMatchObject({
      schemaVersion: 2,
      classification: "authenticated",
      reasonCode: null,
      request,
    });
    const after = await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.head(
      runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY,
    );
    expect(after).toMatchObject({
      version: before?.version,
      etag: before?.etag,
      size: before?.size,
    });
  });

  test("rejects a missing bundle without creating an object", async () => {
    const proof = await runtimeEnv.JSON_COMPATIBILITY_SOURCE_VERIFIER_NAMED
      .authenticateTransitionSource(sourceRequest());
    expect(proof).toMatchObject({
      classification: "rejected",
      reasonCode: "source_bundle_missing",
    });
    expect(await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.head(
      runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY,
    )).toBeNull();
  });

  test("rechecks a signer revocation marker and rejects deterministically", async () => {
    await putBundle();
    const revocationKey = sourceAuthenticationRevocationKey(
      runtimeEnv.TEST_SOURCE_SIGNER_SPKI_SHA256,
    );
    await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.put(
      revocationKey,
      "revoked\n",
      { httpMetadata: { contentType: "text/plain" } },
    );
    const proof = await runtimeEnv.JSON_COMPATIBILITY_SOURCE_VERIFIER_NAMED
      .authenticateTransitionSource(sourceRequest());
    expect(proof).toMatchObject({
      classification: "rejected",
      reasonCode: "source_signer_revoked",
    });
  });
});

function sourceRequest():
JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2 {
  return JSON.parse(runtimeEnv.TEST_SOURCE_AUTHENTICATION_REQUEST) as
    JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2;
}

async function putBundle(): Promise<void> {
  await runtimeEnv.SOURCE_AUTHENTICATION_BUCKET.put(
    runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_KEY,
    runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE,
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contract:
          "cinatoken-container-runtime-json-compatibility-source-authentication-bundle-v1",
        bundleSha256: runtimeEnv.TEST_SOURCE_AUTHENTICATION_BUNDLE_SHA256,
        sourceSignatureEnvelopeSha256:
          runtimeEnv.TEST_SOURCE_SIGNATURE_ENVELOPE_SHA256,
      },
    },
  );
}
