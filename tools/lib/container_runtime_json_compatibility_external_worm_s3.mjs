import { createHash } from "node:crypto";

import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_SCHEMA_VERSION = 1;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER = "amazon-s3";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE =
  "amazon-s3-object-lock-data-plane-observation-only";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_CREDENTIAL_REMAINING_SECONDS =
  3_600;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MIN_CREDENTIAL_REMAINING_SECONDS =
  60;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES =
  512 * 1024 * 1024;

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT =
  Object.freeze({
    writer: Object.freeze({
      accessKeyId:
        "CINATOKEN_EXTERNAL_WORM_S3_WRITER_ACCESS_KEY_ID",
      secretAccessKey:
        "CINATOKEN_EXTERNAL_WORM_S3_WRITER_SECRET_ACCESS_KEY",
      sessionToken:
        "CINATOKEN_EXTERNAL_WORM_S3_WRITER_SESSION_TOKEN",
      expiresAt:
        "CINATOKEN_EXTERNAL_WORM_S3_WRITER_EXPIRES_AT",
    }),
    reader: Object.freeze({
      accessKeyId:
        "CINATOKEN_EXTERNAL_WORM_S3_READER_ACCESS_KEY_ID",
      secretAccessKey:
        "CINATOKEN_EXTERNAL_WORM_S3_READER_SECRET_ACCESS_KEY",
      sessionToken:
        "CINATOKEN_EXTERNAL_WORM_S3_READER_SESSION_TOKEN",
      expiresAt:
        "CINATOKEN_EXTERNAL_WORM_S3_READER_EXPIRES_AT",
    }),
  });

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_FORBIDDEN_CREDENTIAL_ENVIRONMENT =
  Object.freeze([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_S3",
    "AWS_MAX_ATTEMPTS",
    "AWS_RETRY_MODE",
    "AWS_SDK_LOAD_CONFIG",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CF_API_TOKEN",
    "CF_API_KEY",
    "CF_EMAIL",
    "WRANGLER_API_TOKEN",
    "WRANGLER_API_KEY",
    "WRANGLER_EMAIL",
    "WRANGLER_AUTH_TOKEN",
  ]);

const ROLE_NAMES = Object.freeze(["writer", "reader"]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const BUCKET_NAME =
  /^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const AWS_REGION = /^(?=.{3,64}$)(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)+$/;
const EXPECTED_BUCKET_OWNER = /^\d{12}$/;
const ACCESS_KEY_ID = /^[A-Za-z0-9]{16,128}$/;
const METADATA_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CANONICAL_RETAIN_UNTIL =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const MAX_KEY_BYTES = 1_024;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_VALUE_BYTES = 1_024;
const DEFAULT_TIMEOUT_MS = 30_000;
const RESERVED_METADATA = Object.freeze([
  "cinatoken-content-length",
  "cinatoken-content-sha256",
  "cinatoken-retain-until",
]);
const SAFE_PROVIDER_ERROR_CODES = new Set([
  "AccessDenied",
  "AuthorizationHeaderMalformed",
  "ChecksumMismatch",
  "ExpiredToken",
  "InternalError",
  "InvalidBucketState",
  "InvalidRequest",
  "InvalidToken",
  "MethodNotAllowed",
  "NoSuchBucket",
  "NoSuchKey",
  "NotFound",
  "ObjectLockConfigurationNotFoundError",
  "PermanentRedirect",
  "PreconditionFailed",
  "RequestTimeout",
  "ServiceUnavailable",
  "SignatureDoesNotMatch",
  "SlowDown",
]);

export class JsonCompatibilityExternalWormS3InputError extends Error {
  constructor(code) {
    super(code);
    this.name = "JsonCompatibilityExternalWormS3InputError";
    this.code = code;
  }
}

class ProviderTimeoutError extends Error {
  constructor() {
    super("provider_timeout");
    this.name = "ProviderTimeoutError";
  }
}

class BodyMismatchError extends Error {
  constructor(code) {
    super(code);
    this.name = "BodyMismatchError";
    this.code = code;
  }
}

export function readJsonCompatibilityExternalWormS3RoleCredentials(
  role,
  environment,
  options = {},
) {
  requireRole(role);
  if (!environment || typeof environment !== "object") {
    fail("credential_environment_invalid");
  }
  const now = normalizeNow(options.now ?? Date.now());
  const maximumRemainingSeconds = positiveInteger(
    options.maximumRemainingSeconds
      ?? JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_CREDENTIAL_REMAINING_SECONDS,
    "maximum_credential_remaining_seconds_invalid",
  );
  const minimumRemainingSeconds = positiveInteger(
    options.minimumRemainingSeconds
      ?? JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MIN_CREDENTIAL_REMAINING_SECONDS,
    "minimum_credential_remaining_seconds_invalid",
  );
  if (minimumRemainingSeconds >= maximumRemainingSeconds) {
    fail("credential_lifetime_bounds_invalid");
  }

  const otherRole = role === "writer" ? "reader" : "writer";
  const forbidden = [
    ...JSON_COMPATIBILITY_EXTERNAL_WORM_S3_FORBIDDEN_CREDENTIAL_ENVIRONMENT,
    ...Object.values(
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT[otherRole],
    ),
  ];
  if (forbidden.some((name) => hasOwn(environment, name))) {
    fail("forbidden_credential_environment_present");
  }

  const names = JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT[role];
  const accessKeyId = requiredCredential(
    environment[names.accessKeyId],
    names.accessKeyId,
    16,
    128,
    ACCESS_KEY_ID,
  );
  const secretAccessKey = requiredCredential(
    environment[names.secretAccessKey],
    names.secretAccessKey,
    32,
    4_096,
  );
  const sessionToken = requiredCredential(
    environment[names.sessionToken],
    names.sessionToken,
    16,
    8_192,
  );
  if (
    accessKeyId === secretAccessKey
    || accessKeyId === sessionToken
    || secretAccessKey === sessionToken
  ) {
    fail("credential_values_must_differ");
  }
  const expiresAt = canonicalTimestamp(
    environment[names.expiresAt],
    "credential_expiry_invalid",
  );
  const remainingMilliseconds = Date.parse(expiresAt) - now;
  if (
    remainingMilliseconds
      < minimumRemainingSeconds * 1_000
    || remainingMilliseconds
      > maximumRemainingSeconds * 1_000
  ) {
    fail("credential_lifetime_not_short_term");
  }

  return Object.freeze({
    role,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAt,
    credentialIdSha256: sha256Hex(accessKeyId),
  });
}

export function createJsonCompatibilityExternalWormS3AwsAdapter({
  region,
  credentials,
}) {
  const normalizedRegion = normalizeRegion(region, "aws_region_invalid");
  const normalizedCredentials = normalizeRoleCredentials(credentials);
  const client = new S3Client({
    region: normalizedRegion,
    maxAttempts: 1,
    followRegionRedirects: false,
    credentials: {
      accessKeyId: normalizedCredentials.accessKeyId,
      secretAccessKey: normalizedCredentials.secretAccessKey,
      sessionToken: normalizedCredentials.sessionToken,
      expiration: new Date(normalizedCredentials.expiresAt),
    },
  });
  return Object.freeze({
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: normalizedRegion,
    maxAttempts: 1,
    putObject(input, signal) {
      return client.send(new PutObjectCommand(input), {
        abortSignal: signal,
      });
    },
    getBucketVersioning(input, signal) {
      return client.send(new GetBucketVersioningCommand(input), {
        abortSignal: signal,
      });
    },
    getObjectLockConfiguration(input, signal) {
      return client.send(new GetObjectLockConfigurationCommand(input), {
        abortSignal: signal,
      });
    },
    getObject(input, signal) {
      return client.send(new GetObjectCommand(input), {
        abortSignal: signal,
      });
    },
    getObjectRetention(input, signal) {
      return client.send(new GetObjectRetentionCommand(input), {
        abortSignal: signal,
      });
    },
    destroy() {
      client.destroy();
    },
  });
}

export async function publishJsonCompatibilityExternalWormS3Object({
  adapter,
  credentials,
  target,
  object,
  clock = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const now = normalizeNow(clock());
  const normalizedCredentials = normalizeRoleCredentials(
    credentials,
    "writer",
    now,
  );
  const normalizedTarget = normalizeTarget(target);
  const normalizedAdapter = normalizeAdapter(
    adapter,
    ["putObject"],
    normalizedTarget.region,
  );
  const normalizedObject = normalizePublishObject(object, now);
  const boundedTimeout = normalizeTimeout(timeoutMs);
  const base = {
    ...observationBase(
      "put-object",
      now,
      normalizedTarget,
      normalizedCredentials,
    ),
    requested: {
      ifNoneMatch: "*",
      contentLength: normalizedObject.contentLength,
      contentSha256: normalizedObject.contentSha256,
      checksumSha256Base64: normalizedObject.checksumSha256Base64,
      contentType: normalizedObject.contentType,
      metadata: normalizedObject.metadata,
      metadataSha256: normalizedObject.metadataSha256,
      objectLockMode: "COMPLIANCE",
      retainUntil: normalizedObject.retainUntil,
    },
    providerResponse: null,
    providerReadback: null,
  };
  const input = {
    Bucket: normalizedTarget.bucket,
    Key: normalizedTarget.key,
    Body: normalizedObject.body,
    ContentLength: normalizedObject.contentLength,
    ContentType: normalizedObject.contentType,
    Metadata: normalizedObject.metadata,
    IfNoneMatch: "*",
    ObjectLockMode: "COMPLIANCE",
    ObjectLockRetainUntilDate: new Date(normalizedObject.retainUntil),
    ChecksumSHA256: normalizedObject.checksumSha256Base64,
    ExpectedBucketOwner: normalizedTarget.expectedBucketOwner,
  };
  const call = await invokeOnce(
    normalizedAdapter.putObject,
    input,
    boundedTimeout,
  );
  if (!call.ok) {
    return ambiguousObservation(base, 1, "put-object", call.error);
  }
  const output = call.value;
  const responseIssue = validatePutObjectOutput(output, normalizedObject);
  if (responseIssue !== null) {
    return ambiguousObservation(base, 1, "put-object", {
      category: "incomplete-provider-response",
      code: responseIssue,
      metadata: providerMetadata(output),
    });
  }

  return {
    ...base,
    classification: "observed",
    providerCallsAttempted: 1,
    retryPerformed: false,
    providerResponse: {
      versionId: output.VersionId,
      versionIdSha256: sha256Hex(output.VersionId),
      eTag: output.ETag,
      eTagSha256: sha256Hex(output.ETag),
      checksumSha256Base64: output.ChecksumSHA256,
      httpStatusCode: output.$metadata.httpStatusCode,
      providerRequestIdSha256: sha256Hex(output.$metadata.requestId),
    },
  };
}

export async function readBackJsonCompatibilityExternalWormS3Object({
  adapter,
  credentials,
  target,
  publication,
  clock = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const now = normalizeNow(clock());
  const normalizedCredentials = normalizeRoleCredentials(
    credentials,
    "reader",
    now,
  );
  const normalizedTarget = normalizeTarget(target);
  const normalizedAdapter = normalizeAdapter(
    adapter,
    [
      "getBucketVersioning",
      "getObjectLockConfiguration",
      "getObject",
      "getObjectRetention",
    ],
    normalizedTarget.region,
  );
  const normalizedPublication = normalizePublication(
    publication,
    normalizedTarget,
  );
  if (
    normalizedCredentials.credentialIdSha256
      === normalizedPublication.credential.credentialIdSha256
  ) {
    fail("writer_reader_credential_id_must_differ");
  }
  const boundedTimeout = normalizeTimeout(timeoutMs);
  const expected = normalizedPublication.expected;
  const base = {
    ...observationBase(
      "independent-readback",
      now,
      normalizedTarget,
      normalizedCredentials,
    ),
    requested: {
      versionId: expected.versionId,
      versionIdSha256: expected.versionIdSha256,
      eTag: expected.eTag,
      eTagSha256: expected.eTagSha256,
      checksumMode: "ENABLED",
      contentLength: expected.contentLength,
      contentSha256: expected.contentSha256,
      checksumSha256Base64: expected.checksumSha256Base64,
      contentType: expected.contentType,
      metadata: expected.metadata,
      metadataSha256: expected.metadataSha256,
      objectLockMode: "COMPLIANCE",
      retainUntil: expected.retainUntil,
    },
    providerReadback: null,
  };
  base.writerCredentialIdSha256 =
    normalizedPublication.credential.credentialIdSha256;
  let providerCallsAttempted = 0;

  const versioning = await invokeOnce(
    normalizedAdapter.getBucketVersioning,
    {
      Bucket: normalizedTarget.bucket,
      ExpectedBucketOwner: normalizedTarget.expectedBucketOwner,
    },
    boundedTimeout,
  );
  providerCallsAttempted += 1;
  if (!versioning.ok) {
    return ambiguousObservation(
      base,
      providerCallsAttempted,
      "get-bucket-versioning",
      versioning.error,
    );
  }
  if (!successfulResponse(versioning.value)) {
    return ambiguousIncompleteReadback(
      base,
      providerCallsAttempted,
      "get-bucket-versioning",
      versioning.value,
    );
  }
  if (versioning.value.Status !== "Enabled") {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-bucket-versioning",
      "bucket_versioning_not_enabled",
    );
  }

  const lock = await invokeOnce(
    normalizedAdapter.getObjectLockConfiguration,
    {
      Bucket: normalizedTarget.bucket,
      ExpectedBucketOwner: normalizedTarget.expectedBucketOwner,
    },
    boundedTimeout,
  );
  providerCallsAttempted += 1;
  if (!lock.ok) {
    return ambiguousObservation(
      base,
      providerCallsAttempted,
      "get-object-lock-configuration",
      lock.error,
    );
  }
  if (!successfulResponse(lock.value)) {
    return ambiguousIncompleteReadback(
      base,
      providerCallsAttempted,
      "get-object-lock-configuration",
      lock.value,
    );
  }
  if (
    lock.value.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled"
  ) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-lock-configuration",
      "bucket_object_lock_not_enabled",
    );
  }

  const objectCall = await invokeOnce(
    normalizedAdapter.getObject,
    {
      Bucket: normalizedTarget.bucket,
      Key: normalizedTarget.key,
      VersionId: expected.versionId,
      ExpectedBucketOwner: normalizedTarget.expectedBucketOwner,
      ChecksumMode: "ENABLED",
    },
    boundedTimeout,
  );
  providerCallsAttempted += 1;
  if (!objectCall.ok) {
    return ambiguousObservation(
      base,
      providerCallsAttempted,
      "get-object",
      objectCall.error,
    );
  }
  if (!successfulResponse(objectCall.value)) {
    return ambiguousIncompleteReadback(
      base,
      providerCallsAttempted,
      "get-object",
      objectCall.value,
    );
  }
  const objectIssue = validateGetObjectHeaders(objectCall.value, expected);
  if (objectIssue !== null) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object",
      objectIssue,
    );
  }

  let streamed;
  try {
    streamed = await hashStreamingBody(
      objectCall.value.Body,
      expected.contentLength,
      boundedTimeout,
    );
  } catch (error) {
    if (error instanceof BodyMismatchError) {
      return mismatchObservation(
        base,
        providerCallsAttempted,
        "get-object-body",
        error.code,
      );
    }
    return ambiguousObservation(
      base,
      providerCallsAttempted,
      "get-object-body",
      normalizeProviderError(error),
    );
  }
  if (streamed.contentLength !== expected.contentLength) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-body",
      "object_content_length_mismatch",
    );
  }
  if (
    streamed.contentSha256 !== expected.contentSha256
    || streamed.checksumSha256Base64 !== expected.checksumSha256Base64
  ) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-body",
      "object_content_sha256_mismatch",
    );
  }

  const retention = await invokeOnce(
    normalizedAdapter.getObjectRetention,
    {
      Bucket: normalizedTarget.bucket,
      Key: normalizedTarget.key,
      VersionId: expected.versionId,
      ExpectedBucketOwner: normalizedTarget.expectedBucketOwner,
    },
    boundedTimeout,
  );
  providerCallsAttempted += 1;
  if (!retention.ok) {
    return ambiguousObservation(
      base,
      providerCallsAttempted,
      "get-object-retention",
      retention.error,
    );
  }
  if (!successfulResponse(retention.value)) {
    return ambiguousIncompleteReadback(
      base,
      providerCallsAttempted,
      "get-object-retention",
      retention.value,
    );
  }
  const retentionMode = retention.value.Retention?.Mode;
  if (retentionMode !== "COMPLIANCE") {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-retention",
      retentionMode === "GOVERNANCE"
        ? "object_retention_mode_governance"
        : "object_retention_mode_not_compliance",
    );
  }
  const actualRetainUntil = normalizeProviderDate(
    retention.value.Retention?.RetainUntilDate,
  );
  if (actualRetainUntil === null) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-retention",
      "object_retain_until_missing",
    );
  }
  if (Date.parse(actualRetainUntil) < Date.parse(expected.retainUntil)) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-retention",
      "object_retention_shortened",
    );
  }
  if (actualRetainUntil !== expected.retainUntil) {
    return mismatchObservation(
      base,
      providerCallsAttempted,
      "get-object-retention",
      "object_retain_until_mismatch",
    );
  }

  const objectRetainUntil = normalizeProviderDate(
    objectCall.value.ObjectLockRetainUntilDate,
  );
  const observedMetadata = normalizeObservedMetadata(
    objectCall.value.Metadata,
  );

  return {
    ...base,
    classification: "observed",
    providerCallsAttempted,
    retryPerformed: false,
    providerReadback: {
      bucket: {
        versioning: versioning.value.Status,
        objectLock:
          lock.value.ObjectLockConfiguration.ObjectLockEnabled,
        versioningRequestIdSha256:
          optionalDigest(versioning.value.$metadata.requestId),
        objectLockRequestIdSha256:
          optionalDigest(lock.value.$metadata.requestId),
      },
      object: {
        versionId: objectCall.value.VersionId,
        versionIdSha256: sha256Hex(objectCall.value.VersionId),
        eTag: objectCall.value.ETag,
        eTagSha256: sha256Hex(objectCall.value.ETag),
        contentLength: streamed.contentLength,
        contentSha256: streamed.contentSha256,
        checksumSha256Base64: streamed.checksumSha256Base64,
        contentType: objectCall.value.ContentType,
        metadata: observedMetadata,
        metadataSha256: sha256Hex(canonicalMetadata(observedMetadata)),
        objectLockMode: objectCall.value.ObjectLockMode,
        retainUntil: objectRetainUntil,
        providerRequestIdSha256:
          optionalDigest(objectCall.value.$metadata.requestId),
      },
      retention: {
        objectLockMode: retentionMode,
        retainUntil: actualRetainUntil,
        providerRequestIdSha256:
          optionalDigest(retention.value.$metadata.requestId),
      },
    },
  };
}

function normalizeAdapter(adapter, methods, expectedRegion) {
  if (!adapter || typeof adapter !== "object") {
    fail("s3_adapter_invalid");
  }
  if (adapter.provider !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER) {
    fail("s3_adapter_provider_invalid");
  }
  const region = normalizeRegion(adapter.region, "s3_adapter_region_invalid");
  if (region !== expectedRegion) {
    fail("s3_adapter_region_mismatch");
  }
  if (adapter.maxAttempts !== 1) {
    fail("s3_adapter_retry_policy_invalid");
  }
  const normalized = { region };
  for (const method of methods) {
    if (typeof adapter[method] !== "function") {
      fail("s3_adapter_method_missing");
    }
    normalized[method] = adapter[method].bind(adapter);
  }
  return normalized;
}

function normalizeRoleCredentials(credentials, expectedRole, now) {
  if (!credentials || typeof credentials !== "object") {
    fail("role_credentials_invalid");
  }
  requireRole(credentials.role);
  if (expectedRole !== undefined && credentials.role !== expectedRole) {
    fail("role_credentials_mismatch");
  }
  const accessKeyId = requiredCredential(
    credentials.accessKeyId,
    "accessKeyId",
    16,
    128,
    ACCESS_KEY_ID,
  );
  const secretAccessKey = requiredCredential(
    credentials.secretAccessKey,
    "secretAccessKey",
    32,
    4_096,
  );
  const sessionToken = requiredCredential(
    credentials.sessionToken,
    "sessionToken",
    16,
    8_192,
  );
  const expiresAt = canonicalTimestamp(
    credentials.expiresAt,
    "credential_expiry_invalid",
  );
  const credentialIdSha256 = sha256Hex(accessKeyId);
  if (credentials.credentialIdSha256 !== credentialIdSha256) {
    fail("credential_id_digest_mismatch");
  }
  if (now !== undefined) {
    const remaining = Date.parse(expiresAt) - now;
    if (
      remaining
        < JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MIN_CREDENTIAL_REMAINING_SECONDS
          * 1_000
      || remaining
        > JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_CREDENTIAL_REMAINING_SECONDS
          * 1_000
    ) {
      fail("credential_not_current_short_term");
    }
  }
  return {
    role: credentials.role,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAt,
    credentialIdSha256,
  };
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object") {
    fail("s3_target_invalid");
  }
  if (!hasExactKeys(target, [
    "provider",
    "region",
    "bucket",
    "key",
    "expectedBucketOwner",
  ])) {
    fail("s3_target_fields_invalid");
  }
  if (target.provider !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER) {
    fail("s3_target_provider_invalid");
  }
  const region = normalizeRegion(target.region, "s3_target_region_invalid");
  if (typeof target.bucket !== "string" || !BUCKET_NAME.test(target.bucket)) {
    fail("s3_bucket_invalid");
  }
  if (
    typeof target.key !== "string"
    || target.key.length === 0
    || Buffer.byteLength(target.key, "utf8") > MAX_KEY_BYTES
    || /[\u0000-\u001f\u007f]/.test(target.key)
  ) {
    fail("s3_object_key_invalid");
  }
  if (
    typeof target.expectedBucketOwner !== "string"
    || !EXPECTED_BUCKET_OWNER.test(target.expectedBucketOwner)
  ) {
    fail("s3_expected_bucket_owner_invalid");
  }
  return {
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region,
    bucket: target.bucket,
    key: target.key,
    expectedBucketOwner: target.expectedBucketOwner,
  };
}

function normalizePublishObject(object, now) {
  if (!object || typeof object !== "object") {
    fail("publish_object_invalid");
  }
  if (!(object.body instanceof Uint8Array)) {
    fail("publish_body_must_be_uint8array");
  }
  if (
    object.body.byteLength < 1
    || object.body.byteLength
      > JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES
  ) {
    fail("publish_body_size_invalid");
  }
  const body = Uint8Array.from(object.body);
  const contentType = safeText(
    object.contentType,
    "publish_content_type_invalid",
    1,
    256,
  );
  const retainUntil = canonicalRetainUntil(object.retainUntil);
  if (Date.parse(retainUntil) <= now) {
    fail("publish_retain_until_not_future");
  }
  const contentSha256 = sha256Hex(body);
  const checksumSha256Base64 = sha256Base64(body);
  const metadata = normalizeMetadata(object.metadata, {
    "cinatoken-content-length": String(body.byteLength),
    "cinatoken-content-sha256": contentSha256,
    "cinatoken-retain-until": retainUntil,
  });
  return {
    body,
    contentLength: body.byteLength,
    contentSha256,
    checksumSha256Base64,
    contentType,
    metadata,
    metadataSha256: sha256Hex(canonicalMetadata(metadata)),
    retainUntil,
  };
}

function normalizeMetadata(input, required) {
  if (input === undefined) input = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("publish_metadata_invalid");
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_METADATA_ENTRIES - RESERVED_METADATA.length) {
    fail("publish_metadata_too_many_entries");
  }
  const normalized = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase();
    if (
      key !== rawKey
      || !METADATA_KEY.test(key)
      || RESERVED_METADATA.includes(key)
      || Object.hasOwn(normalized, key)
    ) {
      fail("publish_metadata_key_invalid");
    }
    const value = safeText(
      rawValue,
      "publish_metadata_value_invalid",
      0,
      MAX_METADATA_VALUE_BYTES,
    );
    normalized[key] = value;
  }
  return sortedObject({ ...normalized, ...required });
}

function normalizePublication(publication, target) {
  if (
    !publication
    || typeof publication !== "object"
    || publication.schemaVersion
      !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_SCHEMA_VERSION
    || publication.contract
      !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT
    || publication.provider !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER
    || publication.decisionScope
      !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE
    || publication.authorizesC2Closure !== false
    || publication.operation !== "put-object"
    || publication.classification !== "observed"
    || publication.retryPerformed !== false
    || publication.providerCallsAttempted !== 1
  ) {
    fail("publication_observation_invalid");
  }
  if (
    publication.target?.region !== target.region
    || publication.target?.bucketNameSha256 !== sha256Hex(target.bucket)
    || publication.target?.objectKeySha256 !== sha256Hex(target.key)
    || publication.target?.expectedBucketOwnerSha256
      !== sha256Hex(target.expectedBucketOwner)
  ) {
    fail("publication_target_mismatch");
  }
  if (
    publication.credential?.role !== "writer"
    || !SHA256_HEX.test(publication.credential.credentialIdSha256 ?? "")
  ) {
    fail("publication_writer_credential_invalid");
  }
  canonicalTimestamp(
    publication.credential.expiresAt,
    "publication_writer_credential_expiry_invalid",
  );
  canonicalTimestamp(
    publication.observedAt,
    "publication_observed_at_invalid",
  );
  if (publication.providerReadback !== null) {
    fail("publication_provider_readback_invalid");
  }
  const requested = publication.requested;
  if (!requested || typeof requested !== "object") {
    fail("publication_requested_invalid");
  }
  if (
    requested.ifNoneMatch !== "*"
    || !Number.isSafeInteger(requested.contentLength)
    || requested.contentLength < 1
    || requested.contentLength
      > JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES
    || !SHA256_HEX.test(requested.contentSha256 ?? "")
    || !BASE64_SHA256.test(requested.checksumSha256Base64 ?? "")
    || Buffer.from(requested.contentSha256, "hex").toString("base64")
      !== requested.checksumSha256Base64
    || requested.objectLockMode !== "COMPLIANCE"
  ) {
    fail("publication_requested_integrity_invalid");
  }
  const retainUntil = canonicalRetainUntil(requested.retainUntil);
  const contentType = safeText(
    requested.contentType,
    "publication_content_type_invalid",
    1,
    256,
  );
  const metadata = normalizeObservedMetadata(requested.metadata);
  if (
    metadata["cinatoken-content-length"]
      !== String(requested.contentLength)
    || metadata["cinatoken-content-sha256"]
      !== requested.contentSha256
    || metadata["cinatoken-retain-until"] !== retainUntil
    || requested.metadataSha256
      !== sha256Hex(canonicalMetadata(metadata))
  ) {
    fail("publication_metadata_integrity_invalid");
  }

  const providerResponse = publication.providerResponse;
  if (!providerResponse || typeof providerResponse !== "object") {
    fail("publication_provider_response_invalid");
  }
  const versionId = safeText(
    providerResponse.versionId,
    "publication_version_id_invalid",
    1,
    1_024,
  );
  const eTag = safeText(
    providerResponse.eTag,
    "publication_etag_invalid",
    1,
    256,
  );
  if (
    providerResponse.versionIdSha256 !== sha256Hex(versionId)
    || providerResponse.eTagSha256 !== sha256Hex(eTag)
    || providerResponse.checksumSha256Base64
      !== requested.checksumSha256Base64
    || providerResponse.httpStatusCode !== 200
    || !SHA256_HEX.test(
      providerResponse.providerRequestIdSha256 ?? "",
    )
  ) {
    fail("publication_provider_response_integrity_invalid");
  }
  return {
    ...publication,
    requested: {
      ...requested,
      contentType,
      retainUntil,
      metadata,
    },
    providerResponse: {
      ...providerResponse,
      versionId,
      eTag,
    },
    expected: {
      versionId,
      versionIdSha256: providerResponse.versionIdSha256,
      eTag,
      eTagSha256: providerResponse.eTagSha256,
      contentLength: requested.contentLength,
      contentSha256: requested.contentSha256,
      checksumSha256Base64: requested.checksumSha256Base64,
      contentType,
      metadata,
      metadataSha256: requested.metadataSha256,
      retainUntil,
    },
  };
}

function validatePutObjectOutput(output, expected) {
  if (output?.$metadata?.httpStatusCode !== 200) {
    return "put_object_status_invalid";
  }
  if (!validProviderText(output.VersionId, 1, 1_024)) {
    return "put_object_version_id_missing";
  }
  if (!validProviderText(output.ETag, 1, 256)) {
    return "put_object_etag_missing";
  }
  if (output.ChecksumSHA256 !== expected.checksumSha256Base64) {
    return "put_object_checksum_mismatch";
  }
  if (!validProviderText(output.$metadata.requestId, 1, 1_024)) {
    return "put_object_request_id_missing";
  }
  return null;
}

function validateGetObjectHeaders(output, expected) {
  if (output.VersionId !== expected.versionId) {
    return "object_version_id_mismatch";
  }
  if (output.ETag !== expected.eTag) return "object_etag_mismatch";
  if (output.ContentLength !== expected.contentLength) {
    return "object_content_length_header_mismatch";
  }
  if (output.ChecksumSHA256 !== expected.checksumSha256Base64) {
    return "object_checksum_header_mismatch";
  }
  if (output.ContentType !== expected.contentType) {
    return "object_content_type_mismatch";
  }
  let metadata;
  try {
    metadata = normalizeObservedMetadata(output.Metadata);
  } catch {
    return "object_metadata_invalid";
  }
  if (canonicalMetadata(metadata) !== canonicalMetadata(expected.metadata)) {
    return "object_metadata_mismatch";
  }
  if (output.ObjectLockMode !== "COMPLIANCE") {
    return output.ObjectLockMode === "GOVERNANCE"
      ? "object_header_retention_mode_governance"
      : "object_header_retention_mode_not_compliance";
  }
  const retainUntil = normalizeProviderDate(
    output.ObjectLockRetainUntilDate,
  );
  if (retainUntil === null) {
    return "object_header_retain_until_missing";
  }
  if (Date.parse(retainUntil) < Date.parse(expected.retainUntil)) {
    return "object_header_retention_shortened";
  }
  if (retainUntil !== expected.retainUntil) {
    return "object_header_retain_until_mismatch";
  }
  if (output.Body === undefined || output.Body === null) {
    return "object_body_missing";
  }
  return null;
}

async function hashStreamingBody(body, maximumBytes, timeoutMs) {
  let timedOut = false;
  let timer;
  const consume = async () => {
    const hash = createHash("sha256");
    let contentLength = 0;
    for await (const rawChunk of bodyChunks(body)) {
      const chunk = normalizeBodyChunk(rawChunk);
      contentLength += chunk.byteLength;
      if (contentLength > maximumBytes) {
        throw new BodyMismatchError("object_body_exceeds_expected_length");
      }
      hash.update(chunk);
    }
    const digest = hash.digest();
    return {
      contentLength,
      contentSha256: digest.toString("hex"),
      checksumSha256Base64: digest.toString("base64"),
    };
  };
  try {
    return await Promise.race([
      consume(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          cancelStreamingBody(body);
          reject(new ProviderTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) throw new ProviderTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cancelStreamingBody(body) {
  try {
    if (typeof body?.destroy === "function") {
      body.destroy();
    } else if (typeof body?.cancel === "function") {
      void body.cancel();
    } else if (typeof body?.return === "function") {
      void Promise.resolve(body.return()).catch(() => {});
    }
  } catch {
    // Cancellation is best effort after the observation is already ambiguous.
  }
}

async function* bodyChunks(body) {
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    yield body;
    return;
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    yield* body;
    return;
  }
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        yield item.value;
      }
    } finally {
      reader.releaseLock?.();
    }
  } else {
    throw new BodyMismatchError("object_body_stream_invalid");
  }
}

function normalizeBodyChunk(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new BodyMismatchError("object_body_chunk_invalid");
}

async function invokeOnce(method, input, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => method(input, controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new ProviderTimeoutError());
        }, timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: normalizeProviderError(
        timedOut ? new ProviderTimeoutError() : error,
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function observationBase(operation, now, target, credentials) {
  return {
    schemaVersion: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    decisionScope: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
    authorizesC2Closure: false,
    operation,
    observedAt: new Date(now).toISOString(),
    target: {
      region: target.region,
      bucketNameSha256: sha256Hex(target.bucket),
      objectKeySha256: sha256Hex(target.key),
      expectedBucketOwnerSha256: sha256Hex(target.expectedBucketOwner),
    },
    credential: {
      role: credentials.role,
      credentialIdSha256: credentials.credentialIdSha256,
      expiresAt: credentials.expiresAt,
    },
  };
}

function ambiguousObservation(base, calls, phase, error) {
  return {
    ...base,
    classification: "ambiguous",
    providerCallsAttempted: calls,
    retryPerformed: false,
    phase,
    error: {
      category: error.category,
      code: error.code,
      httpStatusCode: error.metadata?.httpStatusCode ?? null,
      providerRequestIdSha256:
        optionalDigest(error.metadata?.requestId) ?? null,
    },
  };
}

function mismatchObservation(base, calls, phase, code) {
  return {
    ...base,
    classification: "mismatch",
    providerCallsAttempted: calls,
    retryPerformed: false,
    phase,
    mismatch: { code },
  };
}

function ambiguousIncompleteReadback(base, calls, phase, output) {
  return ambiguousObservation(base, calls, phase, {
    category: "incomplete-provider-response",
    code: "provider_success_status_missing",
    metadata: providerMetadata(output),
  });
}

function normalizeProviderError(error) {
  const rawCode = error?.Code ?? error?.code ?? error?.name;
  if (
    error instanceof ProviderTimeoutError
    || (
      typeof rawCode === "string"
      && /(?:abort|timeout|timedout|etimedout)/i.test(rawCode)
    )
  ) {
    return {
      category: "timeout",
      code: "provider_timeout",
      metadata: {},
    };
  }
  const metadata = providerMetadata(error);
  return {
    category: "provider-error",
    code: safeProviderCode(rawCode),
    metadata,
  };
}

function providerMetadata(value) {
  const metadata = value?.$metadata;
  return {
    httpStatusCode: Number.isInteger(metadata?.httpStatusCode)
      ? metadata.httpStatusCode
      : null,
    requestId: typeof metadata?.requestId === "string"
      ? metadata.requestId
      : null,
  };
}

function safeProviderCode(value) {
  if (typeof value === "string" && SAFE_PROVIDER_ERROR_CODES.has(value)) {
    return value;
  }
  return "provider_error";
}

function validProviderText(value, minimumBytes, maximumBytes) {
  return Boolean(
    typeof value === "string"
    && Buffer.byteLength(value, "utf8") >= minimumBytes
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\u0000-\u001f\u007f]/.test(value),
  );
}

function successfulResponse(output) {
  return Boolean(
    output
    && typeof output === "object"
    && Number.isInteger(output.$metadata?.httpStatusCode)
    && output.$metadata.httpStatusCode >= 200
    && output.$metadata.httpStatusCode < 300,
  );
}

function normalizeObservedMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("observed_metadata_invalid");
  }
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.toLowerCase();
    if (
      key !== rawKey
      || !METADATA_KEY.test(key)
      || Object.hasOwn(normalized, key)
      || typeof rawValue !== "string"
      || Buffer.byteLength(rawValue, "utf8") > MAX_METADATA_VALUE_BYTES
      || /[\u0000-\u001f\u007f]/.test(rawValue)
    ) {
      fail("observed_metadata_invalid");
    }
    normalized[key] = rawValue;
  }
  return sortedObject(normalized);
}

function normalizeProviderDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return null;
  }
  const iso = value.toISOString();
  return CANONICAL_RETAIN_UNTIL.test(iso) ? iso : null;
}

function canonicalRetainUntil(value) {
  const timestamp = canonicalTimestamp(value, "retain_until_invalid");
  if (!CANONICAL_RETAIN_UNTIL.test(timestamp)) {
    fail("retain_until_must_have_second_precision");
  }
  return timestamp;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code);
  if (new Date(milliseconds).toISOString() !== value) fail(code);
  return value;
}

function requiredCredential(value, _name, minimum, maximum, pattern) {
  if (
    typeof value !== "string"
    || value.length < minimum
    || value.length > maximum
    || /\s|[\u0000-\u001f\u007f]/.test(value)
    || (pattern && !pattern.test(value))
  ) {
    fail("required_role_credential_invalid");
  }
  return value;
}

function safeText(value, code, minimumBytes, maximumBytes) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < minimumBytes
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f]/.test(value)
  ) fail(code);
  return value;
}

function normalizeRegion(value, code) {
  if (typeof value !== "string" || !AWS_REGION.test(value)) fail(code);
  return value;
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    fail("provider_timeout_invalid");
  }
  return value;
}

function normalizeNow(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("clock_invalid");
  }
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function requireRole(role) {
  if (!ROLE_NAMES.includes(role)) fail("credential_role_invalid");
}

function optionalDigest(value) {
  return typeof value === "string" && value.length > 0
    ? sha256Hex(value)
    : null;
}

function canonicalMetadata(metadata) {
  return JSON.stringify(sortedObject(metadata));
}

function sortedObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64(value) {
  return createHash("sha256").update(value).digest("base64");
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function fail(code) {
  throw new JsonCompatibilityExternalWormS3InputError(code);
}
