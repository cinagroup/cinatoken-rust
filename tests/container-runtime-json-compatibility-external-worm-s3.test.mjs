import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_FORBIDDEN_CREDENTIAL_ENVIRONMENT,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT,
  readBackJsonCompatibilityExternalWormS3Object,
  readJsonCompatibilityExternalWormS3RoleCredentials,
  publishJsonCompatibilityExternalWormS3Object,
} from "../tools/lib/container_runtime_json_compatibility_external_worm_s3.mjs";

const NOW = Date.parse("2026-08-06T00:00:00.000Z");
const RETAIN_UNTIL = "2027-08-07T00:00:00.000Z";
const TARGET = Object.freeze({
  provider: "amazon-s3",
  region: "ap-southeast-1",
  bucket: "cinatoken-external-worm",
  key: "container-runtime/c2/source-evidence.tar.zst",
  expectedBucketOwner: "123456789012",
});
const BODY = new TextEncoder().encode(
  "canonical external WORM source evidence",
);
const CONTENT_TYPE = "application/zstd";
const USER_METADATA = Object.freeze({
  "evidence-kind": "source-packet",
  "schema-version": "1",
});

describe("JSON compatibility external WORM Amazon S3 data plane", () => {
  test("reads only short-term role credentials and rejects contamination", () => {
    const writerEnvironment = credentialEnvironment(
      "writer",
      "ASIAWRITER000000001",
    );
    const writer = readCredentials("writer", writerEnvironment);

    expect(writer.role).toBe("writer");
    expect(writer.expiresAt).toBe("2026-08-06T00:30:00.000Z");
    expect(writer.credentialIdSha256).toBe(
      sha256Hex("ASIAWRITER000000001"),
    );

    const readerNames =
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT.reader;
    expect(() => readCredentials("writer", {
      ...writerEnvironment,
      [readerNames.accessKeyId]: "ASIAREADER000000001",
    })).toThrow(/forbidden_credential_environment_present/);

    for (const name of [
      "AWS_PROFILE",
      "AWS_REGION",
      "CLOUDFLARE_API_TOKEN",
      "WRANGLER_API_TOKEN",
    ]) {
      expect(
        JSON_COMPATIBILITY_EXTERNAL_WORM_S3_FORBIDDEN_CREDENTIAL_ENVIRONMENT,
      ).toContain(name);
      expect(() => readCredentials("writer", {
        ...writerEnvironment,
        [name]: "pollution",
      })).toThrow(/forbidden_credential_environment_present/);
    }

    const names =
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT.writer;
    expect(() => readCredentials("writer", {
      ...writerEnvironment,
      [names.expiresAt]: "2026-08-06T02:00:00.000Z",
    })).toThrow(/credential_lifetime_not_short_term/);
    expect(() => readCredentials("writer", {
      ...writerEnvironment,
      [names.sessionToken]: undefined,
    })).toThrow(/required_role_credential_invalid/);
  });

  test("publishes exactly once with create-only COMPLIANCE retention", async () => {
    const writer = credentials("writer", "ASIAWRITER000000001");
    const calls = [];
    const adapter = putAdapter(async (input, signal) => {
      calls.push(input);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(input.Bucket).toBe(TARGET.bucket);
      expect(input.Key).toBe(TARGET.key);
      expect(input.IfNoneMatch).toBe("*");
      expect(input.ObjectLockMode).toBe("COMPLIANCE");
      expect(input.ObjectLockRetainUntilDate).toEqual(
        new Date(RETAIN_UNTIL),
      );
      expect(input.ChecksumSHA256).toBe(sha256Base64(BODY));
      expect(input.ExpectedBucketOwner).toBe(TARGET.expectedBucketOwner);
      expect(input.ContentLength).toBe(BODY.byteLength);
      expect(input.Body).toEqual(BODY);
      expect(input.Metadata).toEqual({
        "cinatoken-content-length": String(BODY.byteLength),
        "cinatoken-content-sha256": sha256Hex(BODY),
        "cinatoken-retain-until": RETAIN_UNTIL,
        "evidence-kind": "source-packet",
        "schema-version": "1",
      });
      return putOutput();
    });

    const observation = await publish(adapter, writer);

    expect(calls).toHaveLength(1);
    expect(observation.contract).toBe(
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
    );
    expect(observation.decisionScope).toBe(
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
    );
    expect(observation.authorizesC2Closure).toBe(false);
    expect(observation.target.region).toBe(TARGET.region);
    expect(JSON.stringify(observation.target)).not.toContain(TARGET.bucket);
    expect(JSON.stringify(observation.target)).not.toContain(TARGET.key);
    expect(JSON.stringify(observation.target)).not.toContain(
      TARGET.expectedBucketOwner,
    );
    expect(observation.classification).toBe("observed");
    expect(observation.providerCallsAttempted).toBe(1);
    expect(observation.retryPerformed).toBe(false);
    expect(observation.requested.objectLockMode).toBe("COMPLIANCE");
    expect(observation.requested.retainUntil).toBe(RETAIN_UNTIL);
    expect(observation.providerResponse).toMatchObject({
      httpStatusCode: 200,
      versionId: "version-0001",
      eTag: '"publication-etag"',
      checksumSha256Base64: sha256Base64(BODY),
    });
    expect(observation.providerResponse.providerRequestIdSha256)
      .toBe(sha256Hex("put-object-request"));
    expect(observation.providerResponse).not.toHaveProperty(
      "objectLockMode",
    );
    expect(observation.providerResponse).not.toHaveProperty(
      "retainUntil",
    );
    expect(observation.providerReadback).toBeNull();
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain(writer.accessKeyId);
    expect(serialized).not.toContain(writer.secretAccessKey);
    expect(serialized).not.toContain(writer.sessionToken);
  });

  test("classifies provider failures and timeouts as ambiguous without retry", async () => {
    const writer = credentials("writer", "ASIAWRITER000000001");
    let failureCalls = 0;
    const failed = await publish(
      putAdapter(() => {
        failureCalls += 1;
        throw Object.assign(new Error("provider detail must not escape"), {
          name: "ServiceUnavailable",
          $metadata: {
            httpStatusCode: 503,
            requestId: "provider-failure-request",
          },
        });
      }),
      writer,
    );
    expect(failureCalls).toBe(1);
    expect(failed.classification).toBe("ambiguous");
    expect(failed.error.category).toBe("provider-error");
    expect(failed.retryPerformed).toBe(false);
    expect(failed.requested.objectLockMode).toBe("COMPLIANCE");
    expect(failed.providerResponse).toBeNull();
    expect(JSON.stringify(failed)).not.toContain("provider detail");

    const missingRequestId = await publish(
      putAdapter(() => putOutput({
        $metadata: { httpStatusCode: 200 },
      })),
      writer,
    );
    expect(missingRequestId.classification).toBe("ambiguous");
    expect(missingRequestId.error.code).toBe(
      "put_object_request_id_missing",
    );

    let timeoutCalls = 0;
    const timedOut = await publish(
      putAdapter((_input, signal) => {
        timeoutCalls += 1;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), {
              name: "AbortError",
            }));
          }, { once: true });
        });
      }),
      writer,
      { timeoutMs: 5 },
    );
    expect(timeoutCalls).toBe(1);
    expect(timedOut.classification).toBe("ambiguous");
    expect(timedOut.error.category).toBe("timeout");
    expect(timedOut.error.code).toBe("provider_timeout");
    expect(timedOut.providerCallsAttempted).toBe(1);
    expect(timedOut.retryPerformed).toBe(false);
  });

  test("independently reads exact version after bucket control checks", async () => {
    const publication = await successfulPublication();
    const reader = credentials("reader", "ASIAREADER000000001");
    const order = [];
    const adapter = readAdapter(publication, { order });

    const observation = await readBack(adapter, reader, publication);

    expect(order).toEqual([
      "getBucketVersioning",
      "getObjectLockConfiguration",
      "getObject",
      "getObjectRetention",
    ]);
    expect(observation.classification).toBe("observed");
    expect(observation.authorizesC2Closure).toBe(false);
    expect(observation.providerCallsAttempted).toBe(4);
    expect(observation.retryPerformed).toBe(false);
    expect(observation.writerCredentialIdSha256).not.toBe(
      observation.credential.credentialIdSha256,
    );
    expect(observation.requested).toMatchObject({
      versionId: publication.providerResponse.versionId,
      objectLockMode: "COMPLIANCE",
      retainUntil: RETAIN_UNTIL,
    });
    expect(observation.providerReadback).toMatchObject({
      bucket: {
        versioning: "Enabled",
        objectLock: "Enabled",
      },
      object: {
        versionId: publication.providerResponse.versionId,
        eTag: publication.providerResponse.eTag,
        contentLength: BODY.byteLength,
        contentSha256: sha256Hex(BODY),
        objectLockMode: "COMPLIANCE",
        retainUntil: RETAIN_UNTIL,
      },
      retention: {
        objectLockMode: "COMPLIANCE",
        retainUntil: RETAIN_UNTIL,
      },
    });
  });

  test("rejects a Cloudflare R2 adapter before any provider request", async () => {
    const publication = await successfulPublication();
    const reader = credentials("reader", "ASIAREADER000000001");
    let calls = 0;
    const r2Adapter = {
      ...readAdapter(publication),
      provider: "cloudflare-r2",
      getBucketVersioning() {
        calls += 1;
      },
    };

    await expect(readBack(r2Adapter, reader, publication)).rejects
      .toMatchObject({ code: "s3_adapter_provider_invalid" });
    expect(calls).toBe(0);
  });

  test("rejects an adapter region mismatch before any provider request", async () => {
    const writer = credentials("writer", "ASIAWRITER000000001");
    let calls = 0;
    const adapter = {
      ...putAdapter(() => {
        calls += 1;
        return putOutput();
      }),
      region: "us-east-1",
    };

    await expect(publish(adapter, writer)).rejects.toMatchObject({
      code: "s3_adapter_region_mismatch",
    });
    expect(calls).toBe(0);

    const missingRetryPolicy = { ...putAdapter(() => putOutput()) };
    delete missingRetryPolicy.maxAttempts;
    await expect(publish(missingRetryPolicy, writer)).rejects.toMatchObject({
      code: "s3_adapter_retry_policy_invalid",
    });
  });

  test("reports GOVERNANCE and shortened retention as mismatches", async () => {
    const publication = await successfulPublication();
    const reader = credentials("reader", "ASIAREADER000000001");

    const governanceHeader = await readBack(
      readAdapter(publication, { getObjectMode: "GOVERNANCE" }),
      reader,
      publication,
    );
    expect(governanceHeader.classification).toBe("mismatch");
    expect(governanceHeader.mismatch.code).toBe(
      "object_header_retention_mode_governance",
    );

    const shortenedHeader = await readBack(
      readAdapter(publication, {
        getObjectRetainUntil: new Date("2027-08-06T23:59:59.000Z"),
      }),
      reader,
      publication,
    );
    expect(shortenedHeader.classification).toBe("mismatch");
    expect(shortenedHeader.mismatch.code).toBe(
      "object_header_retention_shortened",
    );

    const governance = await readBack(
      readAdapter(publication, {
        retention: {
          Mode: "GOVERNANCE",
          RetainUntilDate: new Date(RETAIN_UNTIL),
        },
      }),
      reader,
      publication,
    );
    expect(governance.classification).toBe("mismatch");
    expect(governance.mismatch.code).toBe(
      "object_retention_mode_governance",
    );

    const shortened = await readBack(
      readAdapter(publication, {
        retention: {
          Mode: "COMPLIANCE",
          RetainUntilDate: new Date("2027-08-06T23:59:59.000Z"),
        },
      }),
      reader,
      publication,
    );
    expect(shortened.classification).toBe("mismatch");
    expect(shortened.mismatch.code).toBe("object_retention_shortened");
  });

  test("reports version, metadata, and streamed body drift", async () => {
    const publication = await successfulPublication();
    const reader = credentials("reader", "ASIAREADER000000001");

    const version = await readBack(
      readAdapter(publication, { versionId: "version-drift" }),
      reader,
      publication,
    );
    expect(version.classification).toBe("mismatch");
    expect(version.mismatch.code).toBe("object_version_id_mismatch");

    const metadata = await readBack(
      readAdapter(publication, {
        metadata: {
          ...publication.requested.metadata,
          "evidence-kind": "different-packet",
        },
      }),
      reader,
      publication,
    );
    expect(metadata.classification).toBe("mismatch");
    expect(metadata.mismatch.code).toBe("object_metadata_mismatch");

    const driftedBody = Uint8Array.from(BODY);
    driftedBody[0] ^= 1;
    const body = await readBack(
      readAdapter(publication, { body: driftedBody }),
      reader,
      publication,
    );
    expect(body.classification).toBe("mismatch");
    expect(body.mismatch.code).toBe("object_content_sha256_mismatch");
  });

  test("rejects a reader credential with the writer credential ID", async () => {
    const writerAccessKeyId = "ASIASHARED000000001";
    const writer = credentials("writer", writerAccessKeyId);
    const publication = await publish(
      putAdapter(() => putOutput()),
      writer,
    );
    const reader = credentials("reader", writerAccessKeyId);
    let calls = 0;
    const adapter = readAdapter(publication, {
      onCall() {
        calls += 1;
      },
    });

    await expect(readBack(adapter, reader, publication)).rejects
      .toMatchObject({ code: "writer_reader_credential_id_must_differ" });
    expect(calls).toBe(0);
  });
});

function credentialEnvironment(role, accessKeyId) {
  const names = JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT[role];
  return {
    [names.accessKeyId]: accessKeyId,
    [names.secretAccessKey]: `${role}-secret-access-key-0000000000000000`,
    [names.sessionToken]: `${role}-session-token-00000000000000000000`,
    [names.expiresAt]: "2026-08-06T00:30:00.000Z",
  };
}

function credentials(role, accessKeyId) {
  return readCredentials(role, credentialEnvironment(role, accessKeyId));
}

function readCredentials(role, environment) {
  return readJsonCompatibilityExternalWormS3RoleCredentials(
    role,
    environment,
    { now: NOW },
  );
}

function putAdapter(putObject) {
  return {
    provider: "amazon-s3",
    region: TARGET.region,
    maxAttempts: 1,
    putObject,
  };
}

function putOutput(overrides = {}) {
  return {
    $metadata: {
      httpStatusCode: 200,
      requestId: "put-object-request",
    },
    VersionId: "version-0001",
    ETag: '"publication-etag"',
    ChecksumSHA256: sha256Base64(BODY),
    ...overrides,
  };
}

async function publish(adapter, writer, overrides = {}) {
  return publishJsonCompatibilityExternalWormS3Object({
    adapter,
    credentials: writer,
    target: TARGET,
    object: {
      body: BODY,
      contentType: CONTENT_TYPE,
      metadata: USER_METADATA,
      retainUntil: RETAIN_UNTIL,
    },
    clock: () => NOW,
    timeoutMs: overrides.timeoutMs ?? 100,
  });
}

async function successfulPublication() {
  return publish(
    putAdapter(() => putOutput()),
    credentials("writer", "ASIAWRITER000000001"),
  );
}

function readAdapter(publication, options = {}) {
  const order = options.order ?? [];
  const onCall = options.onCall ?? (() => {});
  const record = (operation, input, signal) => {
    order.push(operation);
    onCall(operation, input);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(input.Bucket).toBe(TARGET.bucket);
    expect(input.ExpectedBucketOwner).toBe(TARGET.expectedBucketOwner);
  };
  return {
    provider: "amazon-s3",
    region: TARGET.region,
    maxAttempts: 1,
    getBucketVersioning(input, signal) {
      record("getBucketVersioning", input, signal);
      return response("versioning-request", {
        Status: options.versioningStatus ?? "Enabled",
      });
    },
    getObjectLockConfiguration(input, signal) {
      record("getObjectLockConfiguration", input, signal);
      return response("object-lock-request", {
        ObjectLockConfiguration: {
          ObjectLockEnabled: options.objectLockEnabled ?? "Enabled",
        },
      });
    },
    getObject(input, signal) {
      record("getObject", input, signal);
      expect(input.Key).toBe(TARGET.key);
      expect(input.VersionId).toBe(publication.providerResponse.versionId);
      expect(input.ChecksumMode).toBe("ENABLED");
      return response("get-object-request", {
        Body: stream(options.body ?? BODY),
        VersionId:
          options.versionId ?? publication.providerResponse.versionId,
        ETag: options.eTag ?? publication.providerResponse.eTag,
        ContentLength: publication.requested.contentLength,
        ContentType: publication.requested.contentType,
        ChecksumSHA256: publication.requested.checksumSha256Base64,
        Metadata: options.metadata ?? publication.requested.metadata,
        ObjectLockMode: options.getObjectMode ?? "COMPLIANCE",
        ObjectLockRetainUntilDate:
          options.getObjectRetainUntil ?? new Date(RETAIN_UNTIL),
      });
    },
    getObjectRetention(input, signal) {
      record("getObjectRetention", input, signal);
      expect(input.Key).toBe(TARGET.key);
      expect(input.VersionId).toBe(publication.providerResponse.versionId);
      return response("retention-request", {
        Retention: options.retention ?? {
          Mode: "COMPLIANCE",
          RetainUntilDate: new Date(RETAIN_UNTIL),
        },
      });
    },
  };
}

async function readBack(adapter, reader, publication, overrides = {}) {
  return readBackJsonCompatibilityExternalWormS3Object({
    adapter,
    credentials: reader,
    target: TARGET,
    publication,
    clock: () => NOW,
    timeoutMs: overrides.timeoutMs ?? 100,
  });
}

function response(requestId, value) {
  return {
    $metadata: { httpStatusCode: 200, requestId },
    ...value,
  };
}

async function* stream(bytes) {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  yield bytes.subarray(0, split);
  yield bytes.subarray(split);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64(value) {
  return createHash("sha256").update(value).digest("base64");
}
