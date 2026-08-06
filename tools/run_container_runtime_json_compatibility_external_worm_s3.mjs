#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson } from "./container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT,
  createJsonCompatibilityExternalWormS3AwsAdapter,
  publishJsonCompatibilityExternalWormS3Object,
  readBackJsonCompatibilityExternalWormS3Object,
  readJsonCompatibilityExternalWormS3RoleCredentials,
} from "./lib/container_runtime_json_compatibility_external_worm_s3.mjs";
import { readBoundedUtf8File } from "./lib/bounded_json_file.mjs";

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-cli-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-single-object-request-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_RESULT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-cli-result-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_MAX_BYTES =
  256 * 1024;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PUBLICATION_MAX_BYTES =
  2 * 1024 * 1024;

const VALUE_OPTIONS = new Set([
  "--mode",
  "--request",
  "--body",
  "--publication",
  "--output",
]);
const FLAG_OPTIONS = new Set(["--dry-run", "--describe", "--help", "-h"]);
const MODES = Object.freeze(["publish", "independent-readback"]);
const REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "contract",
  "provider",
  "region",
  "bucket",
  "key",
  "expectedBucketOwner",
  "contentLength",
  "contentSha256",
  "contentType",
  "metadata",
  "retainUntil",
]);
const PUBLICATION_KEYS = Object.freeze([
  "schemaVersion",
  "contract",
  "provider",
  "decisionScope",
  "authorizesC2Closure",
  "operation",
  "observedAt",
  "target",
  "credential",
  "requested",
  "providerResponse",
  "providerReadback",
  "classification",
  "providerCallsAttempted",
  "retryPerformed",
]);
const PUBLICATION_TARGET_KEYS = Object.freeze([
  "region",
  "bucketNameSha256",
  "objectKeySha256",
  "expectedBucketOwnerSha256",
]);
const PUBLICATION_CREDENTIAL_KEYS = Object.freeze([
  "role",
  "credentialIdSha256",
  "expiresAt",
]);
const PUBLICATION_REQUESTED_KEYS = Object.freeze([
  "ifNoneMatch",
  "contentLength",
  "contentSha256",
  "checksumSha256Base64",
  "contentType",
  "metadata",
  "metadataSha256",
  "objectLockMode",
  "retainUntil",
]);
const PUBLICATION_RESPONSE_KEYS = Object.freeze([
  "versionId",
  "versionIdSha256",
  "eTag",
  "eTagSha256",
  "checksumSha256Base64",
  "httpStatusCode",
  "providerRequestIdSha256",
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const AWS_REGION = /^(?=.{3,64}$)(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)+$/;
const BUCKET_NAME =
  /^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const EXPECTED_BUCKET_OWNER = /^\d{12}$/;
const METADATA_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CANONICAL_RETAIN_UNTIL =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const MAX_KEY_BYTES = 1_024;
const MAX_METADATA_ENTRIES = 29;
const MAX_METADATA_VALUE_BYTES = 1_024;
const RESERVED_METADATA = Object.freeze([
  "cinatoken-content-length",
  "cinatoken-content-sha256",
  "cinatoken-retain-until",
]);

export class JsonCompatibilityExternalWormS3CliError extends Error {
  constructor(code) {
    super(code);
    this.name = "JsonCompatibilityExternalWormS3CliError";
    this.code = code;
  }
}

export class JsonCompatibilityExternalWormS3CliObservationError extends Error {
  constructor(classification) {
    super(`provider_observation_${classification}`);
    this.name = "JsonCompatibilityExternalWormS3CliObservationError";
    this.code = `provider_observation_${classification}`;
    this.classification = classification;
  }
}

export function describeJsonCompatibilityExternalWormS3Cli() {
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_CONTRACT,
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    modes: [...MODES],
    requestContract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_CONTRACT,
    requestFields: [...REQUEST_KEYS],
    roleCredentialEnvironment: {
      writer: { ...JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT.writer },
      reader: { ...JSON_COMPATIBILITY_EXTERNAL_WORM_S3_ROLE_ENVIRONMENT.reader },
    },
    credentialArgumentsAccepted: false,
    adapterMaxAttempts: 1,
    cliRetries: 0,
    createOnceOutput: true,
    outputObservationContract:
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
    outputAuthorizesC2Closure: false,
    maximumBodyBytes:
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES,
  };
}

export function buildJsonCompatibilityExternalWormS3DryRunPlan(mode) {
  requireMode(mode);
  return {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_CONTRACT,
    mode,
    credentialAccess: "none",
    fileReads: 0,
    fileWrites: 0,
    networkRequests: 0,
    adapterCreations: 0,
    cliRetries: 0,
    createOnceOutput: true,
    authorizesC2Closure: false,
    requiredLiveInputs: mode === "publish"
      ? ["request", "body", "output"]
      : ["request", "publication", "output"],
  };
}

export function parseJsonCompatibilityExternalWormS3CliArgs(argv) {
  if (!Array.isArray(argv)) cliFail("argv_invalid");
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (FLAG_OPTIONS.has(argument)) {
      if (flags.has(argument)) cliFail("option_repeated");
      flags.add(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) cliFail("option_unknown");
    if (values.has(argument)) cliFail("option_repeated");
    const value = argv[index + 1];
    if (
      typeof value !== "string"
      || value.length === 0
      || value.startsWith("--")
    ) {
      cliFail("option_value_missing");
    }
    values.set(argument, value);
    index += 1;
  }

  const helpFlags = ["--help", "-h"].filter((flag) => flags.has(flag));
  if (helpFlags.length > 0) {
    if (helpFlags.length !== 1 || flags.size !== 1 || values.size !== 0) {
      cliFail("standalone_mode_has_other_options");
    }
    return { mode: "help" };
  }
  if (flags.has("--describe")) {
    if (flags.size !== 1 || values.size !== 0) {
      cliFail("standalone_mode_has_other_options");
    }
    return { mode: "describe" };
  }

  const operation = values.get("--mode");
  requireMode(operation);
  if (flags.has("--dry-run")) {
    if (flags.size !== 1 || values.size !== 1) {
      cliFail("dry_run_accepts_only_mode");
    }
    return { mode: "dry-run", operation };
  }
  if (flags.size !== 0) cliFail("flag_invalid_for_live_mode");

  const common = {
    mode: operation,
    requestPath: requiredOption(values, "--request"),
    outputPath: requiredOption(values, "--output"),
  };
  if (operation === "publish") {
    requireExactOptions(values, [
      "--mode",
      "--request",
      "--body",
      "--output",
    ]);
    return {
      ...common,
      bodyPath: requiredOption(values, "--body"),
    };
  }
  requireExactOptions(values, [
    "--mode",
    "--request",
    "--publication",
    "--output",
  ]);
  return {
    ...common,
    publicationPath: requiredOption(values, "--publication"),
  };
}

export async function readBoundedJsonCompatibilityExternalWormS3Body(
  filePath,
  maximumBytes = JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES,
) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    cliFail("body_path_invalid");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    cliFail("body_limit_invalid");
  }
  const resolved = resolve(filePath);
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile()) cliFail("body_file_not_regular");
    if (before.size < 1 || before.size > maximumBytes) {
      cliFail("body_file_size_invalid");
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflow = new Uint8Array(1);
    const { bytesRead: overflowBytesRead } = await handle.read(
      overflow,
      0,
      1,
      before.size,
    );
    const after = await handle.stat();
    if (
      offset !== before.size
      || overflowBytesRead !== 0
      || !sameFileIdentity(before, after)
    ) {
      cliFail("body_file_changed");
    }
    return bytes;
  } catch (error) {
    if (error instanceof JsonCompatibilityExternalWormS3CliError) throw error;
    cliFail("body_file_read_failed");
  } finally {
    await handle?.close();
  }
}

export async function runJsonCompatibilityExternalWormS3Cli({
  argv = process.argv.slice(2),
  environment = process.env,
  stdout = process.stdout,
  adapterFactory = createJsonCompatibilityExternalWormS3AwsAdapter,
  clock = Date.now,
} = {}) {
  const options = parseJsonCompatibilityExternalWormS3CliArgs(argv);
  if (options.mode === "help") {
    const usage = jsonCompatibilityExternalWormS3CliUsage();
    stdout.write(`${usage}\n`);
    return { mode: "help", usage };
  }
  if (options.mode === "describe") {
    const description = describeJsonCompatibilityExternalWormS3Cli();
    stdout.write(`${canonicalJson(description)}\n`);
    return description;
  }
  if (options.mode === "dry-run") {
    const plan = buildJsonCompatibilityExternalWormS3DryRunPlan(
      options.operation,
    );
    stdout.write(`${canonicalJson(plan)}\n`);
    return plan;
  }

  const now = normalizeClock(clock());
  const role = options.mode === "publish" ? "writer" : "reader";
  const credentials = readJsonCompatibilityExternalWormS3RoleCredentials(
    role,
    environment,
    { now },
  );

  const request = await readCanonicalRequest(options.requestPath);
  if (
    options.mode === "publish"
    && Date.parse(request.retainUntil) <= now
  ) {
    cliFail("request_retain_until_not_future");
  }
  assertDistinctPaths(options);
  let body;
  let publication;
  if (options.mode === "publish") {
    body = await readBoundedJsonCompatibilityExternalWormS3Body(
      options.bodyPath,
    );
    validateBodyAgainstRequest(body, request);
  } else {
    publication = await readCanonicalPublication(options.publicationPath);
    validatePublicationAgainstRequest(publication, request);
  }

  const outputHandle = await reserveCreateOnceOutput(options.outputPath);
  let adapter;
  let observation;
  try {
    adapter = await adapterFactory({
      region: request.region,
      credentials,
    });
    if (options.mode === "publish") {
      observation = await publishJsonCompatibilityExternalWormS3Object({
        adapter,
        credentials,
        target: targetFromRequest(request),
        object: {
          body,
          contentType: request.contentType,
          metadata: request.metadata,
          retainUntil: request.retainUntil,
        },
        clock: () => now,
      });
    } else {
      observation = await readBackJsonCompatibilityExternalWormS3Object({
        adapter,
        credentials,
        target: targetFromRequest(request),
        publication,
        clock: () => now,
      });
    }
  } catch (error) {
    await outputHandle.close();
    throw error;
  } finally {
    try {
      adapter?.destroy?.();
    } catch {
      // Destroy is cleanup only and cannot replace the provider observation.
    }
  }

  if (
    !observation
    || observation.authorizesC2Closure !== false
    || !["observed", "ambiguous", "mismatch"].includes(
      observation.classification,
    )
  ) {
    await outputHandle.close();
    cliFail("provider_observation_invalid");
  }
  await writeCanonicalObservation(outputHandle, observation);
  stdout.write(`${canonicalJson({
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLI_RESULT_CONTRACT,
    mode: options.mode,
    classification: observation.classification,
    providerCallsAttempted: observation.providerCallsAttempted,
    retryPerformed: false,
    outputCreated: true,
    authorizesC2Closure: false,
  })}\n`);

  if (observation.classification !== "observed") {
    throw new JsonCompatibilityExternalWormS3CliObservationError(
      observation.classification,
    );
  }
  return observation;
}

export function jsonCompatibilityExternalWormS3CliUsage() {
  return [
    "Usage:",
    "  bun tools/run_container_runtime_json_compatibility_external_worm_s3.mjs --mode publish --request <canonical.json> --body <binary> --output <create-once.json>",
    "  bun tools/run_container_runtime_json_compatibility_external_worm_s3.mjs --mode independent-readback --request <canonical.json> --publication <canonical.json> --output <create-once.json>",
    "  bun tools/run_container_runtime_json_compatibility_external_worm_s3.mjs --mode <publish|independent-readback> --dry-run",
    "  bun tools/run_container_runtime_json_compatibility_external_worm_s3.mjs --describe",
    "  bun tools/run_container_runtime_json_compatibility_external_worm_s3.mjs --help",
    "",
    "Credentials are accepted only through the role-specific environment names reported by --describe.",
    "Provider observations never authorize C2 closure by themselves.",
  ].join("\n");
}

async function readCanonicalRequest(filePath) {
  const value = await readCanonicalJsonFile(
    filePath,
    JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_MAX_BYTES,
    "request",
  );
  requireExactKeys(value, REQUEST_KEYS, "request_fields_invalid");
  if (
    value.schemaVersion !== 1
    || value.contract !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_REQUEST_CONTRACT
    || value.provider !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER
  ) {
    cliFail("request_contract_invalid");
  }
  if (typeof value.region !== "string" || !AWS_REGION.test(value.region)) {
    cliFail("request_region_invalid");
  }
  if (typeof value.bucket !== "string" || !BUCKET_NAME.test(value.bucket)) {
    cliFail("request_bucket_invalid");
  }
  if (
    typeof value.key !== "string"
    || value.key.length === 0
    || Buffer.byteLength(value.key, "utf8") > MAX_KEY_BYTES
    || /[\u0000-\u001f\u007f]/.test(value.key)
  ) {
    cliFail("request_key_invalid");
  }
  if (
    typeof value.expectedBucketOwner !== "string"
    || !EXPECTED_BUCKET_OWNER.test(value.expectedBucketOwner)
  ) {
    cliFail("request_expected_bucket_owner_invalid");
  }
  if (
    !Number.isSafeInteger(value.contentLength)
    || value.contentLength < 1
    || value.contentLength
      > JSON_COMPATIBILITY_EXTERNAL_WORM_S3_MAX_OBJECT_BYTES
  ) {
    cliFail("request_content_length_invalid");
  }
  if (typeof value.contentSha256 !== "string" || !SHA256_HEX.test(value.contentSha256)) {
    cliFail("request_content_sha256_invalid");
  }
  boundedText(value.contentType, 1, 256, "request_content_type_invalid");
  const metadata = normalizeRequestMetadata(value.metadata);
  const retainUntil = canonicalRetainUntil(value.retainUntil);
  return Object.freeze({ ...value, metadata, retainUntil });
}

async function readCanonicalPublication(filePath) {
  const value = await readCanonicalJsonFile(
    filePath,
    JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PUBLICATION_MAX_BYTES,
    "publication",
  );
  requireExactKeys(value, PUBLICATION_KEYS, "publication_fields_invalid");
  requireExactKeys(
    value.target,
    PUBLICATION_TARGET_KEYS,
    "publication_target_fields_invalid",
  );
  requireExactKeys(
    value.credential,
    PUBLICATION_CREDENTIAL_KEYS,
    "publication_credential_fields_invalid",
  );
  requireExactKeys(
    value.requested,
    PUBLICATION_REQUESTED_KEYS,
    "publication_requested_fields_invalid",
  );
  requireExactKeys(
    value.providerResponse,
    PUBLICATION_RESPONSE_KEYS,
    "publication_response_fields_invalid",
  );
  if (
    value.schemaVersion !== 1
    || value.contract !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT
    || value.provider !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER
    || value.decisionScope !== JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE
    || value.credential.role !== "writer"
    || typeof value.credential.credentialIdSha256 !== "string"
    || !SHA256_HEX.test(value.credential.credentialIdSha256)
    || !isCanonicalTimestamp(value.credential.expiresAt)
    || !isCanonicalTimestamp(value.observedAt)
    || value.providerResponse.httpStatusCode !== 200
    || typeof value.providerResponse.versionId !== "string"
    || value.providerResponse.versionId.length < 1
    || Buffer.byteLength(value.providerResponse.versionId, "utf8") > 1_024
    || value.providerResponse.versionIdSha256
      !== sha256Hex(value.providerResponse.versionId)
    || typeof value.providerResponse.eTag !== "string"
    || value.providerResponse.eTag.length < 1
    || Buffer.byteLength(value.providerResponse.eTag, "utf8") > 256
    || value.providerResponse.eTagSha256
      !== sha256Hex(value.providerResponse.eTag)
    || typeof value.providerResponse.providerRequestIdSha256 !== "string"
    || !SHA256_HEX.test(value.providerResponse.providerRequestIdSha256)
    || value.providerResponse.checksumSha256Base64
      !== value.requested.checksumSha256Base64
    || value.operation !== "put-object"
    || value.classification !== "observed"
    || value.authorizesC2Closure !== false
    || value.providerCallsAttempted !== 1
    || value.retryPerformed !== false
    || value.providerReadback !== null
  ) {
    cliFail("publication_not_successful");
  }
  return value;
}

async function readCanonicalJsonFile(filePath, maximumBytes, label) {
  let text;
  try {
    text = await readBoundedUtf8File(filePath, maximumBytes, label);
  } catch {
    cliFail(`${label}_file_read_failed`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    cliFail(`${label}_json_invalid`);
  }
  if (text !== `${canonicalJson(value)}\n`) {
    cliFail(`${label}_must_be_canonical_json_single_lf`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    cliFail(`${label}_must_be_object`);
  }
  return value;
}

function validateBodyAgainstRequest(body, request) {
  if (
    body.byteLength !== request.contentLength
    || sha256Hex(body) !== request.contentSha256
  ) {
    cliFail("body_request_integrity_mismatch");
  }
}

function validatePublicationAgainstRequest(publication, request) {
  const expectedMetadata = publicationMetadata(request);
  if (
    publication.target.region !== request.region
    || publication.target.bucketNameSha256 !== sha256Hex(request.bucket)
    || publication.target.objectKeySha256 !== sha256Hex(request.key)
    || publication.target.expectedBucketOwnerSha256
      !== sha256Hex(request.expectedBucketOwner)
  ) {
    cliFail("publication_request_target_mismatch");
  }
  if (
    publication.requested.contentLength !== request.contentLength
    || publication.requested.contentSha256 !== request.contentSha256
    || publication.requested.checksumSha256Base64
      !== Buffer.from(request.contentSha256, "hex").toString("base64")
    || publication.requested.contentType !== request.contentType
    || publication.requested.objectLockMode !== "COMPLIANCE"
    || publication.requested.ifNoneMatch !== "*"
    || publication.requested.retainUntil !== request.retainUntil
    || canonicalJson(publication.requested.metadata)
      !== canonicalJson(expectedMetadata)
    || publication.requested.metadataSha256
      !== sha256Hex(canonicalJson(expectedMetadata))
  ) {
    cliFail("publication_request_object_mismatch");
  }
}

function publicationMetadata(request) {
  return sortedObject({
    ...request.metadata,
    "cinatoken-content-length": String(request.contentLength),
    "cinatoken-content-sha256": request.contentSha256,
    "cinatoken-retain-until": request.retainUntil,
  });
}

function normalizeRequestMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    cliFail("request_metadata_invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) {
    cliFail("request_metadata_too_many_entries");
  }
  const metadata = {};
  for (const [key, rawValue] of entries) {
    if (
      !METADATA_KEY.test(key)
      || RESERVED_METADATA.includes(key)
      || Object.hasOwn(metadata, key)
    ) {
      cliFail("request_metadata_key_invalid");
    }
    boundedText(
      rawValue,
      0,
      MAX_METADATA_VALUE_BYTES,
      "request_metadata_value_invalid",
    );
    metadata[key] = rawValue;
  }
  return Object.freeze(sortedObject(metadata));
}

function canonicalRetainUntil(value) {
  if (
    typeof value !== "string"
    || !CANONICAL_RETAIN_UNTIL.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    cliFail("request_retain_until_invalid");
  }
  return value;
}

function isCanonicalTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function targetFromRequest(request) {
  return {
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: request.region,
    bucket: request.bucket,
    key: request.key,
    expectedBucketOwner: request.expectedBucketOwner,
  };
}

function assertDistinctPaths(options) {
  const paths = [options.requestPath, options.outputPath];
  if (options.mode === "publish") paths.push(options.bodyPath);
  else paths.push(options.publicationPath);
  const resolved = paths.map((value) => resolve(value));
  if (new Set(resolved).size !== resolved.length) {
    cliFail("input_output_paths_must_differ");
  }
}

async function reserveCreateOnceOutput(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    cliFail("output_path_invalid");
  }
  try {
    return await open(resolve(filePath), "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") cliFail("create_once_output_exists");
    cliFail("create_once_output_failed");
  }
}

async function writeCanonicalObservation(handle, observation) {
  const bytes = new TextEncoder().encode(`${canonicalJson(observation)}\n`);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesWritten < 1) cliFail("output_write_incomplete");
      offset += bytesWritten;
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof JsonCompatibilityExternalWormS3CliError) throw error;
    cliFail("output_write_failed");
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function requireExactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    cliFail(code);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    cliFail(code);
  }
}

function requireExactOptions(values, keys) {
  const actual = [...values.keys()].sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    cliFail("live_options_invalid");
  }
}

function requiredOption(values, name) {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) {
    cliFail("required_option_missing");
  }
  return value;
}

function requireMode(mode) {
  if (!MODES.includes(mode)) cliFail("mode_invalid");
}

function boundedText(value, minimumBytes, maximumBytes, code) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < minimumBytes
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    cliFail(code);
  }
  return value;
}

function normalizeClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) cliFail("clock_invalid");
  return value;
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

function cliFail(code) {
  throw new JsonCompatibilityExternalWormS3CliError(code);
}

if (import.meta.main) {
  try {
    await runJsonCompatibilityExternalWormS3Cli();
  } catch (error) {
    const code = typeof error?.code === "string"
      && /^[a-z0-9_]{1,128}$/.test(error.code)
      ? error.code
      : "external_worm_s3_cli_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
