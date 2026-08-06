import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";
import {
  validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest,
} from "./container_runtime_json_compatibility_deployment_transition.mjs";
import {
  JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT,
  sourceAuthenticationBundleKey,
  validateJsonCompatibilitySourceAuthenticationBundle,
} from "./container_runtime_json_compatibility_source_authentication.mjs";

export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_PACKET_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-publication-packet-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_WRITE_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-publication-write-receipt-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_READBACK_REQUEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-publication-readback-request-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLICATION_READBACK_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-source-publication-readback-receipt-v1";
export const JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-source-publisher-staging";
export const JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";

const SCHEMA_VERSION = 1;
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class JsonCompatibilitySourcePublicationProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilitySourcePublicationProtocolError";
    this.code = code;
  }
}

export function buildJsonCompatibilitySourcePublicationPacket({
  sourceAuthenticationRequest: requestInput,
  bundle: bundleInput,
}, { now, requireUsableWindow = true } = {}) {
  const sourceAuthenticationRequest =
    validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
      requestInput,
    );
  const bundle = validateJsonCompatibilitySourceAuthenticationBundle(
    sourceAuthenticationRequest,
    bundleInput,
    { now, requireUsableWindow },
  );
  const sourceSignatureEnvelopeSha256 = sha256Canonical(
    bundle.sourceSignatureEnvelope,
  );
  const bundleKey = sourceAuthenticationBundleKey(
    sourceSignatureEnvelopeSha256,
  );
  const body = sourcePublicationBundleBody(bundle);
  const bodyByteLength = Buffer.byteLength(body, "utf8");
  if (bodyByteLength < 2 || bodyByteLength > MAX_BUNDLE_BYTES) {
    protocolError("source_publication_bundle_size_invalid");
  }
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const objectMetadata = sourcePublicationObjectMetadata(
    bundle.bundleSha256,
    sourceSignatureEnvelopeSha256,
  );
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_PUBLICATION_PACKET_CONTRACT,
    environment: "staging",
    sourceAuthenticationRequest,
    bundle,
    bundleKey,
    bundleSha256: bundle.bundleSha256,
    bodySha256,
    bodyByteLength,
    sourceSignatureEnvelopeSha256,
    objectMetadata,
  };
  return { ...subject, publicationPacketSha256: sha256Canonical(subject) };
}

export function validateJsonCompatibilitySourcePublicationPacket(
  input,
  options = {},
) {
  const value = record(input, "source publication packet");
  exactKeys(value, [
    "schemaVersion", "contract", "environment",
    "sourceAuthenticationRequest", "bundle", "bundleKey", "bundleSha256",
    "bodySha256", "bodyByteLength", "sourceSignatureEnvelopeSha256",
    "objectMetadata", "publicationPacketSha256",
  ], "source publication packet");
  const rebuilt = buildJsonCompatibilitySourcePublicationPacket({
    sourceAuthenticationRequest: value.sourceAuthenticationRequest,
    bundle: value.bundle,
  }, options);
  canonicalEqual(rebuilt, value, "source publication packet");
  return cloneJson(rebuilt);
}

export function sourcePublicationBundleBody(bundle) {
  return `${canonicalJson(bundle)}\n`;
}

export function sourcePublicationObjectMetadata(
  bundleSha256,
  sourceSignatureEnvelopeSha256,
) {
  sha256(bundleSha256, "source publication bundle");
  sha256(
    sourceSignatureEnvelopeSha256,
    "source publication signature envelope",
  );
  return {
    contract: JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT,
    bundleSha256,
    sourceSignatureEnvelopeSha256,
  };
}

export function buildJsonCompatibilitySourcePublicationWriteReceipt({
  publisherServiceName,
  publisherVersionId,
  sourceAuthenticationRequestSha256,
  bundleKey,
  bundleSha256,
  bodySha256,
  bodyByteLength,
  sourceSignatureEnvelopeSha256,
  objectVersionSha256,
  objectEtagSha256,
  publishedAt,
}) {
  equal(
    publisherServiceName,
    JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME,
    "source publisher service name",
  );
  safeToken(publisherVersionId, "source publisher version ID");
  for (const [label, digest] of [
    ["request", sourceAuthenticationRequestSha256],
    ["bundle", bundleSha256],
    ["body", bodySha256],
    ["signature envelope", sourceSignatureEnvelopeSha256],
    ["object version", objectVersionSha256],
    ["object ETag", objectEtagSha256],
  ]) sha256(digest, `source publication ${label}`);
  sourceAuthenticationBundleKey(sourceSignatureEnvelopeSha256);
  if (bundleKey !== sourceAuthenticationBundleKey(
    sourceSignatureEnvelopeSha256,
  )) protocolError("source_publication_bundle_key_mismatch");
  positiveInteger(bodyByteLength, "source publication body length");
  if (bodyByteLength > MAX_BUNDLE_BYTES) {
    protocolError("source_publication_bundle_size_invalid");
  }
  positiveInteger(publishedAt, "source publication time");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_PUBLICATION_WRITE_RECEIPT_CONTRACT,
    environment: "staging",
    publisherServiceName,
    publisherVersionId,
    sourceAuthenticationRequestSha256,
    bundleKey,
    bundleSha256,
    bodySha256,
    bodyByteLength,
    sourceSignatureEnvelopeSha256,
    objectVersionSha256,
    objectEtagSha256,
    publishedAt,
    createOnly: true,
    writeAttemptCount: 1,
    retryPerformed: false,
    readbackPerformed: false,
  };
  return { ...subject, writeReceiptSha256: sha256Canonical(subject) };
}

export function validateJsonCompatibilitySourcePublicationWriteReceipt(input) {
  const value = record(input, "source publication write receipt");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "publisherServiceName",
    "publisherVersionId", "sourceAuthenticationRequestSha256", "bundleKey",
    "bundleSha256", "bodySha256", "bodyByteLength",
    "sourceSignatureEnvelopeSha256", "objectVersionSha256",
    "objectEtagSha256", "publishedAt", "createOnly", "writeAttemptCount",
    "retryPerformed", "readbackPerformed", "writeReceiptSha256",
  ], "source publication write receipt");
  const rebuilt = buildJsonCompatibilitySourcePublicationWriteReceipt({
    publisherServiceName: value.publisherServiceName,
    publisherVersionId: value.publisherVersionId,
    sourceAuthenticationRequestSha256:
      value.sourceAuthenticationRequestSha256,
    bundleKey: value.bundleKey,
    bundleSha256: value.bundleSha256,
    bodySha256: value.bodySha256,
    bodyByteLength: value.bodyByteLength,
    sourceSignatureEnvelopeSha256:
      value.sourceSignatureEnvelopeSha256,
    objectVersionSha256: value.objectVersionSha256,
    objectEtagSha256: value.objectEtagSha256,
    publishedAt: value.publishedAt,
  });
  canonicalEqual(rebuilt, value, "source publication write receipt");
  return cloneJson(rebuilt);
}

export function buildJsonCompatibilitySourcePublicationReadbackRequest({
  sourceAuthenticationRequest: requestInput,
  expectedPublicationPacketSha256,
  writeOutcome,
  writeReceipt: writeReceiptInput,
}) {
  const sourceAuthenticationRequest =
    validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
      requestInput,
    );
  sha256(
    expectedPublicationPacketSha256,
    "source publication expected packet",
  );
  if (writeOutcome !== "published" && writeOutcome !== "ambiguous") {
    protocolError("source_publication_write_outcome_invalid");
  }
  const writeReceipt = writeReceiptInput === null
    ? null
    : validateJsonCompatibilitySourcePublicationWriteReceipt(
      writeReceiptInput,
    );
  if (
    (writeOutcome === "published" && writeReceipt === null)
    || (writeOutcome === "ambiguous" && writeReceipt !== null)
  ) protocolError("source_publication_write_outcome_invalid");
  if (
    writeReceipt !== null
    && writeReceipt.sourceAuthenticationRequestSha256
      !== sourceAuthenticationRequest.sourceAuthenticationRequestSha256
  ) protocolError("source_publication_write_receipt_request_mismatch");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_PUBLICATION_READBACK_REQUEST_CONTRACT,
    environment: "staging",
    sourceAuthenticationRequest,
    expectedPublicationPacketSha256,
    writeOutcome,
    writeReceipt,
  };
  return {
    ...subject,
    sourcePublicationReadbackRequestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilitySourcePublicationReadbackRequest(
  input,
) {
  const value = record(input, "source publication readback request");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "sourceAuthenticationRequest",
    "expectedPublicationPacketSha256", "writeOutcome", "writeReceipt",
    "sourcePublicationReadbackRequestSha256",
  ], "source publication readback request");
  const rebuilt = buildJsonCompatibilitySourcePublicationReadbackRequest({
    sourceAuthenticationRequest: value.sourceAuthenticationRequest,
    expectedPublicationPacketSha256: value.expectedPublicationPacketSha256,
    writeOutcome: value.writeOutcome,
    writeReceipt: value.writeReceipt,
  });
  canonicalEqual(rebuilt, value, "source publication readback request");
  return cloneJson(rebuilt);
}

export function buildJsonCompatibilitySourcePublicationReadbackReceipt({
  sourcePublicationReadbackRequestSha256,
  publicationPacketSha256,
  writeOutcome,
  writeReceiptSha256,
  publisherServiceName,
  publisherVersionId,
  sourceVerifierServiceName,
  sourceVerifierVersionId,
  sourceAuthenticationRequestSha256,
  bundleKey,
  bundleSha256,
  bodySha256,
  bodyByteLength,
  sourceSignatureEnvelopeSha256,
  objectVersionSha256,
  objectEtagSha256,
  objectMetadataSha256,
  signerSpkiSha256,
  verifierIdentitySha256,
  verifiedAt,
}) {
  for (const [label, digest] of [
    ["readback request", sourcePublicationReadbackRequestSha256],
    ["publication packet", publicationPacketSha256],
    ["request", sourceAuthenticationRequestSha256],
    ["bundle", bundleSha256],
    ["body", bodySha256],
    ["signature envelope", sourceSignatureEnvelopeSha256],
    ["object version", objectVersionSha256],
    ["object ETag", objectEtagSha256],
    ["object metadata", objectMetadataSha256],
    ["signer SPKI", signerSpkiSha256],
    ["verifier identity", verifierIdentitySha256],
  ]) sha256(digest, `source publication readback ${label}`);
  if (writeOutcome !== "published" && writeOutcome !== "ambiguous") {
    protocolError("source_publication_write_outcome_invalid");
  }
  if (writeOutcome === "published") {
    sha256(writeReceiptSha256, "source publication readback write receipt");
    equal(
      publisherServiceName,
      JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME,
      "source publication readback publisher service",
    );
    safeToken(
      publisherVersionId,
      "source publication readback publisher version",
    );
  } else if (
    writeReceiptSha256 !== null
    || publisherServiceName !== null
    || publisherVersionId !== null
  ) protocolError("source_publication_write_outcome_invalid");
  equal(
    sourceVerifierServiceName,
    JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME,
    "source publication readback verifier service",
  );
  safeToken(
    sourceVerifierVersionId,
    "source publication readback verifier version",
  );
  if (bundleKey !== sourceAuthenticationBundleKey(
    sourceSignatureEnvelopeSha256,
  )) protocolError("source_publication_bundle_key_mismatch");
  positiveInteger(bodyByteLength, "source publication readback body length");
  if (bodyByteLength > MAX_BUNDLE_BYTES) {
    protocolError("source_publication_bundle_size_invalid");
  }
  positiveInteger(verifiedAt, "source publication verification time");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_SOURCE_PUBLICATION_READBACK_RECEIPT_CONTRACT,
    environment: "staging",
    sourcePublicationReadbackRequestSha256,
    publicationPacketSha256,
    writeOutcome,
    writeReceiptSha256,
    publisherServiceName,
    publisherVersionId,
    sourceVerifierServiceName,
    sourceVerifierVersionId,
    sourceAuthenticationRequestSha256,
    bundleKey,
    bundleSha256,
    bodySha256,
    bodyByteLength,
    sourceSignatureEnvelopeSha256,
    objectVersionSha256,
    objectEtagSha256,
    objectMetadataSha256,
    signerSpkiSha256,
    verifierIdentitySha256,
    verifiedAt,
    exactBodyReadback: true,
    exactVersionReadback: true,
    exactEtagReadback: true,
    exactMetadataReadback: true,
    independentFromPublisher: true,
  };
  return { ...subject, readbackReceiptSha256: sha256Canonical(subject) };
}

function record(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) protocolError("invalid_source_publication_document", `${label} is invalid`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) protocolError("invalid_source_publication_document", `${label} keys are invalid`);
}

function canonicalEqual(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    protocolError("source_publication_binding_mismatch", `${label} does not match`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    protocolError("source_publication_binding_mismatch", `${label} does not match`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    protocolError("invalid_source_publication_sha256", `${label} is invalid`);
  }
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    protocolError("invalid_source_publication_token", `${label} is invalid`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    protocolError("invalid_source_publication_integer", `${label} is invalid`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function protocolError(code, message = code) {
  throw new JsonCompatibilitySourcePublicationProtocolError(code, message);
}
