import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT,
} from "../tools/lib/container_runtime_json_compatibility_external_worm_s3.mjs";
import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_CONTRACT,
  JsonCompatibilityExternalWormS3CliObservationError,
  parseJsonCompatibilityExternalWormS3CliArgs,
  runJsonCompatibilityExternalWormS3Cli,
} from "../tools/run_container_runtime_json_compatibility_external_worm_s3.mjs";

const NOW = Date.parse("2026-08-06T00:00:00.000Z");
const RETAIN_UNTIL = "2027-08-07T00:00:00.000Z";
const REGION = "ap-southeast-1";
const BODY = Uint8Array.from([
  0xef,
  0xbb,
  0xbf,
  ...new TextEncoder().encode("binary archive body"),
]);
const REQUEST = Object.freeze({
  schemaVersion: 1,
  contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_CONTRACT,
  provider: "amazon-s3",
  region: REGION,
  bucket: "cinatoken-external-worm",
  key: "container-runtime/c2/source-evidence.tar.zst",
  expectedBucketOwner: "123456789012",
  contentLength: BODY.byteLength,
  contentSha256: sha256Hex(BODY),
  contentType: "application/zstd",
  metadata: {
    "evidence-kind": "source-packet",
    "schema-version": "1",
  },
  retainUntil: RETAIN_UNTIL,
});

describe("JSON compatibility external WORM Amazon S3 CLI", () => {
  test("keeps dry-run, describe, and help free of environment, files, and network", async () => {
    const forbiddenEnvironment = new Proxy({}, {
      get() {
        throw new Error("environment accessed");
      },
      getOwnPropertyDescriptor() {
        throw new Error("environment inspected");
      },
      ownKeys() {
        throw new Error("environment enumerated");
      },
    });
    for (const mode of ["publish", "independent-readback"]) {
      const output = [];
      const result = await runJsonCompatibilityExternalWormS3Cli({
        argv: ["--mode", mode, "--dry-run"],
        environment: forbiddenEnvironment,
        adapterFactory() {
          throw new Error("adapter created");
        },
        clock() {
          throw new Error("clock accessed");
        },
        stdout: writer(output),
      });
      expect(result).toMatchObject({
        mode,
        credentialAccess: "none",
        fileReads: 0,
        fileWrites: 0,
        networkRequests: 0,
        adapterCreations: 0,
        authorizesC2Closure: false,
      });
      expect(output).toHaveLength(1);
    }

    const described = await runJsonCompatibilityExternalWormS3Cli({
      argv: ["--describe"],
      environment: forbiddenEnvironment,
      adapterFactory() {
        throw new Error("adapter created");
      },
      clock() {
        throw new Error("clock accessed");
      },
      stdout: writer([]),
    });
    expect(described).toMatchObject({
      credentialArgumentsAccepted: false,
      adapterMaxAttempts: 1,
      cliRetries: 0,
      outputAuthorizesC2Closure: false,
    });
    const helped = await runJsonCompatibilityExternalWormS3Cli({
      argv: ["--help"],
      environment: forbiddenEnvironment,
      stdout: writer([]),
    });
    expect(helped.mode).toBe("help");
    expect(helped.usage).toContain("--mode publish");

    expect(() => parseJsonCompatibilityExternalWormS3CliArgs([
      "--mode",
      "publish",
      "--access-key-id",
      "must-never-be-accepted",
    ])).toThrow(/option_unknown/);
  });

  test("rejects generic and mixed credential contamination before file or network access", async () => {
    let adapterCreations = 0;
    const base = credentialEnvironment("writer");
    const contaminated = [
      { ...base, AWS_PROFILE: "forbidden-profile" },
      { ...base, ...credentialEnvironment("reader") },
    ];
    for (const environment of contaminated) {
      await expect(runJsonCompatibilityExternalWormS3Cli({
        argv: publishArgv(
          "missing-request.json",
          "missing-body.bin",
          "must-not-exist.json",
        ),
        environment,
        adapterFactory() {
          adapterCreations += 1;
          throw new Error("network accessed");
        },
        clock: () => NOW,
        stdout: writer([]),
      })).rejects.toMatchObject({
        code: "forbidden_credential_environment_present",
      });
    }
    expect(adapterCreations).toBe(0);
  });

  test("publishes one exact canonical request and treats body BOM bytes as binary", async () => {
    const fixture = await createFixture();
    const calls = [];
    try {
      const observation = await runJsonCompatibilityExternalWormS3Cli({
        argv: publishArgv(
          fixture.requestPath,
          fixture.bodyPath,
          fixture.publicationPath,
        ),
        environment: credentialEnvironment("writer"),
        adapterFactory({ region, credentials }) {
          expect(region).toBe(REGION);
          expect(credentials.role).toBe("writer");
          return putAdapter((input, signal) => {
            calls.push(input);
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(Object.keys(input).sort()).toEqual([
              "Body",
              "Bucket",
              "ChecksumSHA256",
              "ContentLength",
              "ContentType",
              "ExpectedBucketOwner",
              "IfNoneMatch",
              "Key",
              "Metadata",
              "ObjectLockMode",
              "ObjectLockRetainUntilDate",
            ]);
            expect(input).toMatchObject({
              Bucket: REQUEST.bucket,
              Key: REQUEST.key,
              ContentLength: BODY.byteLength,
              ContentType: REQUEST.contentType,
              ExpectedBucketOwner: REQUEST.expectedBucketOwner,
              IfNoneMatch: "*",
              ObjectLockMode: "COMPLIANCE",
              ChecksumSHA256: sha256Base64(BODY),
            });
            expect(input.Body).toEqual(BODY);
            expect(input.Body.subarray(0, 3)).toEqual(
              Uint8Array.from([0xef, 0xbb, 0xbf]),
            );
            expect(input.ObjectLockRetainUntilDate).toEqual(
              new Date(RETAIN_UNTIL),
            );
            return putOutput();
          });
        },
        clock: () => NOW,
        stdout: writer([]),
      });

      expect(calls).toHaveLength(1);
      expect(observation.classification).toBe("observed");
      expect(observation.target.region).toBe(REGION);
      expect(observation.authorizesC2Closure).toBe(false);
      const persisted = await readFile(fixture.publicationPath, "utf8");
      expect(persisted).toBe(`${canonicalJson(observation)}\n`);
      expect(persisted).not.toContain(REQUEST.bucket);
      expect(persisted).not.toContain(REQUEST.key);
      expect(persisted).not.toContain(REQUEST.expectedBucketOwner);

      const extraRequestPath = join(fixture.directory, "extra-request.json");
      await writeFile(
        extraRequestPath,
        `${canonicalJson({ ...REQUEST, endpoint: "forbidden" })}\n`,
        { flag: "wx" },
      );
      let rejectedAdapterCreations = 0;
      await expect(runJsonCompatibilityExternalWormS3Cli({
        argv: publishArgv(
          extraRequestPath,
          fixture.bodyPath,
          join(fixture.directory, "extra-output.json"),
        ),
        environment: credentialEnvironment("writer"),
        adapterFactory() {
          rejectedAdapterCreations += 1;
          return putAdapter(() => putOutput());
        },
        clock: () => NOW,
        stdout: writer([]),
      })).rejects.toMatchObject({ code: "request_fields_invalid" });
      expect(rejectedAdapterCreations).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("independent readback pins the exact successful publication version", async () => {
    const fixture = await createFixture();
    try {
      const publication = await publishFixture(fixture);
      const calls = [];
      const observation = await runJsonCompatibilityExternalWormS3Cli({
        argv: readbackArgv(
          fixture.requestPath,
          fixture.publicationPath,
          fixture.readbackPath,
        ),
        environment: credentialEnvironment("reader"),
        adapterFactory({ region, credentials }) {
          expect(region).toBe(REGION);
          expect(credentials.role).toBe("reader");
          return readAdapter(publication, (operation, input) => {
            calls.push(operation);
            if (operation === "getObject" || operation === "getObjectRetention") {
              expect(input.VersionId).toBe(
                publication.providerResponse.versionId,
              );
            }
          });
        },
        clock: () => NOW,
        stdout: writer([]),
      });

      expect(calls).toEqual([
        "getBucketVersioning",
        "getObjectLockConfiguration",
        "getObject",
        "getObjectRetention",
      ]);
      expect(observation.classification).toBe("observed");
      expect(observation.requested.versionId).toBe(
        publication.providerResponse.versionId,
      );
      expect(observation.authorizesC2Closure).toBe(false);
      expect(await readFile(fixture.readbackPath, "utf8"))
        .toBe(`${canonicalJson(observation)}\n`);
    } finally {
      await fixture.cleanup();
    }
  });

  test("persists ambiguous and mismatch observations exactly once without retry", async () => {
    const ambiguousFixture = await createFixture();
    let publishCalls = 0;
    try {
      await expect(runJsonCompatibilityExternalWormS3Cli({
        argv: publishArgv(
          ambiguousFixture.requestPath,
          ambiguousFixture.bodyPath,
          ambiguousFixture.publicationPath,
        ),
        environment: credentialEnvironment("writer"),
        adapterFactory() {
          return putAdapter(() => {
            publishCalls += 1;
            throw Object.assign(new Error("provider unavailable"), {
              name: "ServiceUnavailable",
              $metadata: {
                httpStatusCode: 503,
                requestId: "ambiguous-request",
              },
            });
          });
        },
        clock: () => NOW,
        stdout: writer([]),
      })).rejects.toBeInstanceOf(
        JsonCompatibilityExternalWormS3CliObservationError,
      );
      const ambiguous = JSON.parse(
        await readFile(ambiguousFixture.publicationPath, "utf8"),
      );
      expect(publishCalls).toBe(1);
      expect(ambiguous).toMatchObject({
        classification: "ambiguous",
        providerCallsAttempted: 1,
        retryPerformed: false,
        authorizesC2Closure: false,
      });
    } finally {
      await ambiguousFixture.cleanup();
    }

    const mismatchFixture = await createFixture();
    try {
      const publication = await publishFixture(mismatchFixture);
      let readCalls = 0;
      await expect(runJsonCompatibilityExternalWormS3Cli({
        argv: readbackArgv(
          mismatchFixture.requestPath,
          mismatchFixture.publicationPath,
          mismatchFixture.readbackPath,
        ),
        environment: credentialEnvironment("reader"),
        adapterFactory() {
          return readAdapter(publication, () => {
            readCalls += 1;
          }, { versioningStatus: "Suspended" });
        },
        clock: () => NOW,
        stdout: writer([]),
      })).rejects.toMatchObject({
        code: "provider_observation_mismatch",
      });
      const mismatch = JSON.parse(
        await readFile(mismatchFixture.readbackPath, "utf8"),
      );
      expect(readCalls).toBe(1);
      expect(mismatch).toMatchObject({
        classification: "mismatch",
        providerCallsAttempted: 1,
        retryPerformed: false,
        phase: "get-bucket-versioning",
        mismatch: { code: "bucket_versioning_not_enabled" },
        authorizesC2Closure: false,
      });
    } finally {
      await mismatchFixture.cleanup();
    }
  });

  test("refuses an occupied output before adapter creation", async () => {
    const fixture = await createFixture();
    let adapterCreations = 0;
    try {
      await writeFile(fixture.publicationPath, "occupied\n", { flag: "wx" });
      await expect(runJsonCompatibilityExternalWormS3Cli({
        argv: publishArgv(
          fixture.requestPath,
          fixture.bodyPath,
          fixture.publicationPath,
        ),
        environment: credentialEnvironment("writer"),
        adapterFactory() {
          adapterCreations += 1;
          return putAdapter(() => putOutput());
        },
        clock: () => NOW,
        stdout: writer([]),
      })).rejects.toMatchObject({ code: "create_once_output_exists" });
      expect(adapterCreations).toBe(0);
      expect(await readFile(fixture.publicationPath, "utf8"))
        .toBe("occupied\n");
    } finally {
      await fixture.cleanup();
    }
  });

  test("redacts role secrets from persisted evidence, output, and typed failure", async () => {
    const fixture = await createFixture();
    const environment = credentialEnvironment("writer");
    const names = JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT.writer;
    const secrets = [
      environment[names.accessKeyId],
      environment[names.secretAccessKey],
      environment[names.sessionToken],
    ];
    const output = [];
    let failure;
    try {
      try {
        await runJsonCompatibilityExternalWormS3Cli({
          argv: publishArgv(
            fixture.requestPath,
            fixture.bodyPath,
            fixture.publicationPath,
          ),
          environment,
          adapterFactory() {
            return putAdapter(() => {
              throw Object.assign(new Error(secrets.join(":")), {
                name: environment[names.secretAccessKey],
                code: environment[names.sessionToken],
                $metadata: { requestId: environment[names.accessKeyId] },
              });
            });
          },
          clock: () => NOW,
          stdout: writer(output),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(
        JsonCompatibilityExternalWormS3CliObservationError,
      );
      const combined = [
        await readFile(fixture.publicationPath, "utf8"),
        output.join(""),
        failure.message,
        failure.code,
      ].join("\n");
      for (const secret of secrets) expect(combined).not.toContain(secret);
      expect(combined).toContain("provider_error");
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "cinatoken-worm-s3-cli-"));
  const requestPath = join(directory, "request.json");
  const bodyPath = join(directory, "body.bin");
  const publicationPath = join(directory, "publication.json");
  const readbackPath = join(directory, "readback.json");
  await writeFile(requestPath, `${canonicalJson(REQUEST)}\n`, { flag: "wx" });
  await writeFile(bodyPath, BODY, { flag: "wx" });
  return {
    directory,
    requestPath,
    bodyPath,
    publicationPath,
    readbackPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function publishFixture(fixture) {
  return runJsonCompatibilityExternalWormS3Cli({
    argv: publishArgv(
      fixture.requestPath,
      fixture.bodyPath,
      fixture.publicationPath,
    ),
    environment: credentialEnvironment("writer"),
    adapterFactory: () => putAdapter(() => putOutput()),
    clock: () => NOW,
    stdout: writer([]),
  });
}

function publishArgv(requestPath, bodyPath, outputPath) {
  return [
    "--mode", "publish",
    "--request", requestPath,
    "--body", bodyPath,
    "--output", outputPath,
  ];
}

function readbackArgv(requestPath, publicationPath, outputPath) {
  return [
    "--mode", "independent-readback",
    "--request", requestPath,
    "--publication", publicationPath,
    "--output", outputPath,
  ];
}

function credentialEnvironment(role) {
  const names = JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT[role];
  return {
    [names.accessKeyId]: role === "writer"
      ? "ASIAWRITER000000001"
      : "ASIAREADER000000001",
    [names.secretAccessKey]:
      `${role}-secret-access-key-0000000000000000`,
    [names.sessionToken]:
      `${role}-session-token-00000000000000000000`,
    [names.expiresAt]: "2026-08-06T00:30:00.000Z",
  };
}

function putAdapter(putObject) {
  return {
    provider: "amazon-s3",
    region: REGION,
    maxAttempts: 1,
    putObject,
  };
}

function putOutput() {
  return {
    $metadata: {
      httpStatusCode: 200,
      requestId: "put-object-request",
    },
    VersionId: "version-0001",
    ETag: '"publication-etag"',
    ChecksumSHA256: sha256Base64(BODY),
  };
}

function readAdapter(publication, onCall = () => {}, options = {}) {
  const record = (operation, input, signal) => {
    onCall(operation, input);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(input.Bucket).toBe(REQUEST.bucket);
    expect(input.ExpectedBucketOwner).toBe(REQUEST.expectedBucketOwner);
  };
  return {
    provider: "amazon-s3",
    region: REGION,
    maxAttempts: 1,
    getBucketVersioning(input, signal) {
      record("getBucketVersioning", input, signal);
      return response("versioning-request", {
        Status: options.versioningStatus ?? "Enabled",
      });
    },
    getObjectLockConfiguration(input, signal) {
      record("getObjectLockConfiguration", input, signal);
      return response("lock-request", {
        ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" },
      });
    },
    getObject(input, signal) {
      record("getObject", input, signal);
      return response("get-object-request", {
        Body: stream(BODY),
        VersionId: publication.providerResponse.versionId,
        ETag: publication.providerResponse.eTag,
        ContentLength: BODY.byteLength,
        ContentType: REQUEST.contentType,
        ChecksumSHA256: sha256Base64(BODY),
        Metadata: publication.requested.metadata,
        ObjectLockMode: "COMPLIANCE",
        ObjectLockRetainUntilDate: new Date(RETAIN_UNTIL),
      });
    },
    getObjectRetention(input, signal) {
      record("getObjectRetention", input, signal);
      return response("retention-request", {
        Retention: {
          Mode: "COMPLIANCE",
          RetainUntilDate: new Date(RETAIN_UNTIL),
        },
      });
    },
  };
}

function response(requestId, value) {
  return {
    $metadata: { httpStatusCode: 200, requestId },
    ...value,
  };
}

async function* stream(bytes) {
  yield bytes.subarray(0, 3);
  yield bytes.subarray(3);
}

function writer(output) {
  return { write: (value) => output.push(value) };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64(value) {
  return createHash("sha256").update(value).digest("base64");
}
