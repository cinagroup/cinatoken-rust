export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_SCHEMA_VERSION = 1;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-provider-observation-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER = "amazon-s3";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE =
  "amazon-s3-object-lock-data-plane-observation-only";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_READBACK_REQUEST_SET_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-readback-request-set-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES =
  512 * 1024 * 1024;

const WRITER_KEYS = Object.freeze([
  "schemaVersion", "contract", "provider", "decisionScope",
  "authorizesC2Closure", "operation", "observedAt", "target",
  "credential", "requested", "providerResponse", "providerReadback",
  "classification", "providerCallsAttempted", "retryPerformed",
]);
const READER_KEYS = Object.freeze([
  "schemaVersion", "contract", "provider", "decisionScope",
  "authorizesC2Closure", "operation", "observedAt", "target",
  "credential", "writerCredentialIdSha256", "requested",
  "providerReadback", "classification", "providerCallsAttempted",
  "retryPerformed",
]);
const TARGET_KEYS = Object.freeze([
  "region", "bucketNameSha256", "objectKeySha256",
  "expectedBucketOwnerSha256",
]);
const CREDENTIAL_KEYS = Object.freeze([
  "role", "credentialIdSha256", "expiresAt",
]);
const WRITER_REQUEST_KEYS = Object.freeze([
  "ifNoneMatch", "contentLength", "contentSha256",
  "checksumSha256Base64", "contentType", "metadata", "metadataSha256",
  "objectLockMode", "retainUntil",
]);
const READER_REQUEST_KEYS = Object.freeze([
  "versionId", "versionIdSha256", "eTag", "eTagSha256", "checksumMode",
  "contentLength", "contentSha256", "checksumSha256Base64", "contentType",
  "metadata", "metadataSha256", "objectLockMode", "retainUntil",
]);
const PROVIDER_RESPONSE_KEYS = Object.freeze([
  "versionId", "versionIdSha256", "eTag", "eTagSha256",
  "checksumSha256Base64", "httpStatusCode", "providerRequestIdSha256",
]);
const PROVIDER_READBACK_KEYS = Object.freeze([
  "bucket", "object", "retention",
]);
const BUCKET_READBACK_KEYS = Object.freeze([
  "versioning", "objectLock", "versioningRequestIdSha256",
  "objectLockRequestIdSha256",
]);
const OBJECT_READBACK_KEYS = Object.freeze([
  "versionId", "versionIdSha256", "eTag", "eTagSha256", "contentLength",
  "contentSha256", "checksumSha256Base64", "contentType", "metadata",
  "metadataSha256", "objectLockMode", "retainUntil",
  "providerRequestIdSha256",
]);
const RETENTION_READBACK_KEYS = Object.freeze([
  "objectLockMode", "retainUntil", "providerRequestIdSha256",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const REGION = /^(?=.{3,64}$)(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)+$/;
const METADATA_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const RETAIN_UNTIL =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const MAX_METADATA_VALUE_BYTES = 1_024;

export class JsonCompatibilityExternalWormS3ObservationError extends Error {
  constructor(code) {
    super(code);
    this.name = "JsonCompatibilityExternalWormS3ObservationError";
    this.code = code;
  }
}

export function canonicalJsonCompatibilityExternalWormS3Json(value) {
  return JSON.stringify(canonicalize(value));
}

export async function sha256JsonCompatibilityExternalWormS3Bytes(value) {
  if (!(value instanceof Uint8Array)) fail("sha256_bytes_invalid");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value);
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256JsonCompatibilityExternalWormS3Text(value) {
  if (typeof value !== "string") fail("sha256_text_invalid");
  return sha256JsonCompatibilityExternalWormS3Bytes(
    new TextEncoder().encode(value),
  );
}

export async function sha256JsonCompatibilityExternalWormS3Canonical(value) {
  return sha256JsonCompatibilityExternalWormS3Text(
    canonicalJsonCompatibilityExternalWormS3Json(value),
  );
}

export async function validateJsonCompatibilityExternalWormS3WriterObservation(
  input,
) {
  const value = record(input, "writer_observation_invalid");
  exactKeys(value, WRITER_KEYS, "writer_observation_keys_invalid");
  commonObservation(value, "put-object", "writer", 1);
  equal(value.classification, "observed", "writer_classification_invalid");
  equal(value.providerReadback, null, "writer_readback_must_be_null");
  const target = normalizeTarget(value.target);
  const credential = normalizeCredential(value.credential, "writer", value.observedAt);
  const requested = await normalizeObjectFacts(
    value.requested,
    WRITER_REQUEST_KEYS,
    true,
  );
  const response = record(value.providerResponse, "writer_response_invalid");
  exactKeys(response, PROVIDER_RESPONSE_KEYS, "writer_response_keys_invalid");
  equal(response.httpStatusCode, 200, "writer_response_status_invalid");
  const versionId = providerText(
    response.versionId,
    1,
    1_024,
    "writer_version_id_invalid",
  );
  const eTag = providerText(
    response.eTag,
    1,
    256,
    "writer_etag_invalid",
  );
  await digestMatches(versionId, response.versionIdSha256, "writer_version_digest_mismatch");
  await digestMatches(eTag, response.eTagSha256, "writer_etag_digest_mismatch");
  equal(
    response.checksumSha256Base64,
    requested.checksumSha256Base64,
    "writer_checksum_mismatch",
  );
  sha256(response.providerRequestIdSha256, "writer_request_id_invalid");
  return cloneJson({
    ...value,
    target,
    credential,
    requested,
    providerResponse: response,
  });
}

export async function validateJsonCompatibilityExternalWormS3ReadbackObservation(
  input,
) {
  const value = record(input, "readback_observation_invalid");
  exactKeys(value, READER_KEYS, "readback_observation_keys_invalid");
  commonObservation(value, "independent-readback", "reader", 4);
  equal(value.classification, "observed", "readback_classification_invalid");
  sha256(value.writerCredentialIdSha256, "readback_writer_credential_invalid");
  const target = normalizeTarget(value.target);
  const credential = normalizeCredential(value.credential, "reader", value.observedAt);
  if (credential.credentialIdSha256 === value.writerCredentialIdSha256) {
    fail("readback_writer_reader_credential_reuse");
  }
  const requested = await normalizeObjectFacts(
    value.requested,
    READER_REQUEST_KEYS,
    false,
  );
  equal(value.requested.checksumMode, "ENABLED", "readback_checksum_mode_invalid");
  const providerReadback = record(
    value.providerReadback,
    "provider_readback_invalid",
  );
  exactKeys(
    providerReadback,
    PROVIDER_READBACK_KEYS,
    "provider_readback_keys_invalid",
  );
  const bucket = record(providerReadback.bucket, "bucket_readback_invalid");
  exactKeys(bucket, BUCKET_READBACK_KEYS, "bucket_readback_keys_invalid");
  equal(bucket.versioning, "Enabled", "bucket_versioning_invalid");
  equal(bucket.objectLock, "Enabled", "bucket_object_lock_invalid");
  sha256(bucket.versioningRequestIdSha256, "versioning_request_id_invalid");
  sha256(bucket.objectLockRequestIdSha256, "object_lock_request_id_invalid");
  const object = await normalizeObjectFacts(
    providerReadback.object,
    OBJECT_READBACK_KEYS,
    false,
  );
  sha256(object.providerRequestIdSha256, "object_request_id_invalid");
  const retention = record(
    providerReadback.retention,
    "retention_readback_invalid",
  );
  exactKeys(
    retention,
    RETENTION_READBACK_KEYS,
    "retention_readback_keys_invalid",
  );
  equal(retention.objectLockMode, "COMPLIANCE", "retention_mode_invalid");
  canonicalRetainUntil(retention.retainUntil, "retention_time_invalid");
  sha256(retention.providerRequestIdSha256, "retention_request_id_invalid");
  for (const property of [
    "versionId", "versionIdSha256", "eTag", "eTagSha256", "contentLength",
    "contentSha256", "checksumSha256Base64", "contentType", "metadata",
    "metadataSha256", "objectLockMode", "retainUntil",
  ]) {
    canonicalEqual(
      object[property],
      requested[property],
      "readback_requested_object_mismatch",
    );
  }
  equal(
    retention.retainUntil,
    object.retainUntil,
    "readback_retention_time_mismatch",
  );
  const requestIds = [
    bucket.versioningRequestIdSha256,
    bucket.objectLockRequestIdSha256,
    object.providerRequestIdSha256,
    retention.providerRequestIdSha256,
  ];
  rejectDuplicates(requestIds, "readback_request_id_duplicate");
  return cloneJson({
    ...value,
    target,
    credential,
    requested,
    providerReadback: { bucket, object, retention },
  });
}

export async function deriveJsonCompatibilityExternalWormS3ReadbackRequestSetSha256(
  observation,
) {
  const value = await validateJsonCompatibilityExternalWormS3ReadbackObservation(
    observation,
  );
  return sha256JsonCompatibilityExternalWormS3Canonical({
    schemaVersion: 1,
    contract:
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_READBACK_REQUEST_SET_CONTRACT,
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: value.target.region,
    bucketNameSha256: value.target.bucketNameSha256,
    expectedBucketOwnerSha256: value.target.expectedBucketOwnerSha256,
    objectKeySha256: value.target.objectKeySha256,
    versionIdSha256: value.requested.versionIdSha256,
    bucketVersioningRequestIdSha256:
      value.providerReadback.bucket.versioningRequestIdSha256,
    bucketObjectLockRequestIdSha256:
      value.providerReadback.bucket.objectLockRequestIdSha256,
    objectRequestIdSha256:
      value.providerReadback.object.providerRequestIdSha256,
    retentionRequestIdSha256:
      value.providerReadback.retention.providerRequestIdSha256,
  });
}

function commonObservation(value, operation, role, calls) {
  equal(value.schemaVersion, 1, "observation_schema_invalid");
  equal(
    value.contract,
    JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
    "observation_contract_invalid",
  );
  equal(value.provider, JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER, "provider_invalid");
  equal(
    value.decisionScope,
    JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
    "decision_scope_invalid",
  );
  equal(value.authorizesC2Closure, false, "provider_c2_authority_invalid");
  equal(value.operation, operation, "observation_operation_invalid");
  equal(value.providerCallsAttempted, calls, "provider_call_count_invalid");
  equal(value.retryPerformed, false, "provider_retry_invalid");
  canonicalTimestamp(value.observedAt, "observation_time_invalid");
  if (value.credential?.role !== role) fail("observation_credential_role_invalid");
}

function normalizeTarget(input) {
  const value = record(input, "target_invalid");
  exactKeys(value, TARGET_KEYS, "target_keys_invalid");
  if (typeof value.region !== "string" || !REGION.test(value.region)) {
    fail("target_region_invalid");
  }
  sha256(value.bucketNameSha256, "target_bucket_invalid");
  sha256(value.objectKeySha256, "target_key_invalid");
  sha256(value.expectedBucketOwnerSha256, "target_owner_invalid");
  return cloneJson(value);
}

function normalizeCredential(input, role, observedAt) {
  const value = record(input, "credential_invalid");
  exactKeys(value, CREDENTIAL_KEYS, "credential_keys_invalid");
  equal(value.role, role, "credential_role_invalid");
  sha256(value.credentialIdSha256, "credential_id_invalid");
  canonicalTimestamp(value.expiresAt, "credential_expiry_invalid");
  const remaining = Date.parse(value.expiresAt) - Date.parse(observedAt);
  if (remaining < 60_000 || remaining > 3_600_000) {
    fail("credential_lifetime_invalid");
  }
  return cloneJson(value);
}

async function normalizeObjectFacts(input, keys, writer) {
  const value = record(input, "object_facts_invalid");
  exactKeys(value, keys, "object_facts_keys_invalid");
  if (writer) equal(value.ifNoneMatch, "*", "writer_if_none_match_invalid");
  if (!Number.isSafeInteger(value.contentLength)
    || value.contentLength < 1
    || value.contentLength > JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES) {
    fail("content_length_invalid");
  }
  sha256(value.contentSha256, "content_sha256_invalid");
  if (!BASE64_SHA256.test(value.checksumSha256Base64 ?? "")) {
    fail("checksum_sha256_invalid");
  }
  equal(
    value.checksumSha256Base64,
    hexSha256ToBase64(value.contentSha256),
    "checksum_content_digest_mismatch",
  );
  providerText(value.contentType, 1, 256, "content_type_invalid");
  const metadata = normalizeMetadata(value.metadata);
  equal(
    value.metadataSha256,
    await sha256JsonCompatibilityExternalWormS3Canonical(metadata),
    "metadata_digest_mismatch",
  );
  equal(value.objectLockMode, "COMPLIANCE", "object_lock_mode_invalid");
  canonicalRetainUntil(value.retainUntil, "retain_until_invalid");
  equal(
    metadata["cinatoken-content-length"],
    String(value.contentLength),
    "metadata_content_length_mismatch",
  );
  equal(
    metadata["cinatoken-content-sha256"],
    value.contentSha256,
    "metadata_content_digest_mismatch",
  );
  equal(
    metadata["cinatoken-retain-until"],
    value.retainUntil,
    "metadata_retention_mismatch",
  );
  if (!writer) {
    const versionId = providerText(value.versionId, 1, 1_024, "version_id_invalid");
    const eTag = providerText(value.eTag, 1, 256, "etag_invalid");
    await digestMatches(versionId, value.versionIdSha256, "version_digest_mismatch");
    await digestMatches(eTag, value.eTagSha256, "etag_digest_mismatch");
  }
  return cloneJson({ ...value, metadata });
}

function normalizeMetadata(input) {
  const value = record(input, "metadata_invalid");
  const entries = Object.entries(value);
  if (entries.length < 3 || entries.length > 32) fail("metadata_count_invalid");
  const normalized = {};
  for (const [key, rawValue] of entries) {
    if (!METADATA_KEY.test(key) || Object.hasOwn(normalized, key)) {
      fail("metadata_key_invalid");
    }
    providerText(rawValue, 0, MAX_METADATA_VALUE_BYTES, "metadata_value_invalid");
    normalized[key] = rawValue;
  }
  return sortedObject(normalized);
}

async function digestMatches(value, digest, code) {
  sha256(digest, code);
  equal(digest, await sha256JsonCompatibilityExternalWormS3Text(value), code);
}

function canonicalTimestamp(value, code) {
  if (typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) fail(code);
  return value;
}

function canonicalRetainUntil(value, code) {
  canonicalTimestamp(value, code);
  if (!RETAIN_UNTIL.test(value)) fail(code);
  return value;
}

function providerText(value, minimumBytes, maximumBytes, code) {
  if (typeof value !== "string"
    || utf8Length(value) < minimumBytes
    || utf8Length(value) > maximumBytes
    || /[\u0000-\u001f\u007f]/.test(value)) fail(code);
  return value;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function hexSha256ToBase64(value) {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical_number_invalid");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail("canonical_undefined_invalid");
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  fail("canonical_value_invalid");
}

function record(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function canonicalEqual(actual, expected, code) {
  if (canonicalJsonCompatibilityExternalWormS3Json(actual)
    !== canonicalJsonCompatibilityExternalWormS3Json(expected)) fail(code);
}

function sha256(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function rejectDuplicates(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function sortedObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
}

function cloneJson(value) {
  return JSON.parse(canonicalJsonCompatibilityExternalWormS3Json(value));
}

function bytesToHex(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function fail(code) {
  throw new JsonCompatibilityExternalWormS3ObservationError(code);
}
