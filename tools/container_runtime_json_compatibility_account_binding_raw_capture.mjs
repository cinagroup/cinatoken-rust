import { createHash } from "node:crypto";

export const JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-terminal-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const RAW_CAPTURE_FILE_NAME = /^[a-z0-9.-]{1,255}$/;
const ACCOUNT_BINDING_RESOURCE_FAMILY_SET = new Set([
  "credential-verification",
  "workers-scripts",
  "worker-deployments",
  "worker-version",
  "worker-subdomain",
  "account-worker-domains",
  "account-zones",
  "zone-worker-routes",
]);
const RAW_CAPTURE_TERMINAL_KEYS = Object.freeze([
  "schemaVersion",
  "contract",
  "kind",
  "environment",
  "mode",
  "accountIdSha256",
  "collectionProfileSha256",
  "collectorIdentitySha256",
  "captureManifestSha256",
  "collectionArtifactSha256",
  "collectionArtifactFileSha256",
  "pageCount",
  "pageChainHeadSha256",
  "rawObjectCount",
  "rawObjectTotalBytes",
  "rawObjectSetSha256",
  "rawObjects",
  "captureTerminalSha256",
]);
const RAW_CAPTURE_OBJECT_KEYS = Object.freeze([
  "sequence",
  "resourceFamily",
  "objectKind",
  "fileName",
  "byteLength",
  "contentSha256",
  "pageReceiptSha256",
  "requestPathSha256",
  "responseBodySha256",
]);

export class JsonCompatibilityAccountBindingRawCaptureError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilityAccountBindingRawCaptureError";
    this.code = code;
  }
}

export function validateJsonCompatibilityAccountBindingRawCaptureTerminal(
  input,
) {
  const value = plainRecord(input, "raw capture terminal");
  exactKeys(value, RAW_CAPTURE_TERMINAL_KEYS, "raw capture terminal");
  if (value.schemaVersion !== 1) {
    fail("raw_capture_terminal_schema_version_invalid");
  }
  if (
    value.contract
      !== JSON_COMPATIBILITY_ACCOUNT_BINDING_RAW_CAPTURE_TERMINAL_CONTRACT
  ) fail("raw_capture_terminal_contract_invalid");
  if (
    value.kind
      !== "container-runtime-json-compatibility-account-binding-raw-capture-terminal"
  ) fail("raw_capture_terminal_kind_invalid");
  if (value.environment !== "staging") {
    fail("raw_capture_terminal_environment_invalid");
  }
  oneOf(
    value.mode,
    ["collection", "independent-readback"],
    "raw capture terminal mode",
  );
  for (const [label, digest] of [
    ["account ID", value.accountIdSha256],
    ["collection profile", value.collectionProfileSha256],
    ["collector identity", value.collectorIdentitySha256],
    ["capture manifest", value.captureManifestSha256],
    ["collection artifact", value.collectionArtifactSha256],
    ["collection artifact file", value.collectionArtifactFileSha256],
    ["page chain head", value.pageChainHeadSha256],
    ["raw object set", value.rawObjectSetSha256],
    ["capture terminal", value.captureTerminalSha256],
  ]) assertSha256(digest, `raw capture terminal ${label}`);
  positiveInteger(value.pageCount, "raw capture terminal page count");
  positiveInteger(value.rawObjectCount, "raw capture terminal object count");
  positiveInteger(
    value.rawObjectTotalBytes,
    "raw capture terminal total bytes",
  );
  if (!Array.isArray(value.rawObjects)) {
    fail("raw_capture_terminal_raw_objects_invalid");
  }

  const rawObjects = value.rawObjects.map((inputValue) => {
    const rawObject = plainRecord(inputValue, "raw capture object");
    exactKeys(rawObject, RAW_CAPTURE_OBJECT_KEYS, "raw capture object");
    positiveInteger(rawObject.sequence, "raw capture object sequence");
    positiveInteger(rawObject.byteLength, "raw capture object byte length");
    if (!ACCOUNT_BINDING_RESOURCE_FAMILY_SET.has(rawObject.resourceFamily)) {
      fail("raw_capture_object_resource_family_invalid");
    }
    oneOf(
      rawObject.objectKind,
      ["body", "receipt"],
      "raw capture object kind",
    );
    if (
      typeof rawObject.fileName !== "string"
      || !RAW_CAPTURE_FILE_NAME.test(rawObject.fileName)
    ) fail("raw_capture_object_file_name_invalid");
    for (const [label, digest] of [
      ["content", rawObject.contentSha256],
      ["page receipt", rawObject.pageReceiptSha256],
      ["request path", rawObject.requestPathSha256],
      ["response body", rawObject.responseBodySha256],
    ]) assertSha256(digest, `raw capture object ${label}`);
    return rawObject;
  });

  if (
    value.rawObjectCount !== rawObjects.length
    || rawObjects.length !== value.pageCount * 2
  ) fail("raw_capture_terminal_object_count_mismatch");
  const fileNames = new Set();
  const pageReceiptDigests = new Set();
  const receiptContentDigests = new Set();
  let rawObjectTotalBytes = 0;
  for (let sequence = 1; sequence <= value.pageCount; sequence += 1) {
    const body = rawObjects[(sequence - 1) * 2];
    const receipt = rawObjects[((sequence - 1) * 2) + 1];
    if (
      body.sequence !== sequence || receipt.sequence !== sequence
      || body.objectKind !== "body" || receipt.objectKind !== "receipt"
    ) fail("raw_capture_terminal_object_order_invalid");
    for (const field of [
      "resourceFamily",
      "pageReceiptSha256",
      "requestPathSha256",
      "responseBodySha256",
    ]) {
      if (body[field] !== receipt[field]) {
        fail("raw_capture_terminal_object_pair_mismatch");
      }
    }
    if (body.contentSha256 !== body.responseBodySha256) {
      fail("raw_capture_terminal_body_digest_mismatch");
    }
    for (const rawObject of [body, receipt]) {
      if (rawObject.fileName !== rawCaptureObjectFileName(rawObject)) {
        fail("raw_capture_terminal_file_name_mismatch");
      }
      if (fileNames.has(rawObject.fileName)) {
        fail("raw_capture_terminal_file_name_duplicate");
      }
      fileNames.add(rawObject.fileName);
      rawObjectTotalBytes += rawObject.byteLength;
      if (!Number.isSafeInteger(rawObjectTotalBytes)) {
        fail("raw_capture_terminal_total_bytes_invalid");
      }
    }
    if (pageReceiptDigests.has(body.pageReceiptSha256)) {
      fail("raw_capture_terminal_page_receipt_digest_duplicate");
    }
    pageReceiptDigests.add(body.pageReceiptSha256);
    if (receiptContentDigests.has(receipt.contentSha256)) {
      fail("raw_capture_terminal_receipt_content_digest_duplicate");
    }
    receiptContentDigests.add(receipt.contentSha256);
  }
  if (value.rawObjectTotalBytes !== rawObjectTotalBytes) {
    fail("raw_capture_terminal_total_bytes_mismatch");
  }
  if (value.rawObjectSetSha256 !== sha256Canonical(rawObjects)) {
    fail("raw_capture_terminal_raw_object_set_sha256_mismatch");
  }
  if (
    value.pageChainHeadSha256
      !== rawObjects.at(-1).pageReceiptSha256
  ) fail("raw_capture_terminal_page_chain_head_mismatch");

  const captureManifestSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-v1",
    environment: "staging",
    mode: value.mode,
    accountIdSha256: value.accountIdSha256,
    collectionProfileSha256: value.collectionProfileSha256,
    collectorIdentitySha256: value.collectorIdentitySha256,
  };
  if (
    value.captureManifestSha256
      !== sha256Canonical(captureManifestSubject)
  ) fail("raw_capture_terminal_capture_manifest_sha256_mismatch");
  const { captureTerminalSha256: _digest, ...terminalSubject } = value;
  if (value.captureTerminalSha256 !== sha256Canonical(terminalSubject)) {
    fail("raw_capture_terminal_sha256_mismatch");
  }
  return cloneJson(value);
}

function rawCaptureObjectFileName(rawObject) {
  return [
    String(rawObject.sequence).padStart(6, "0"),
    rawObject.resourceFamily,
    `${rawObject.pageReceiptSha256}.${rawObject.objectKind}.json`,
  ].join("-");
}

function plainRecord(value, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail(`${label.replaceAll(" ", "_")}_invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label.replaceAll(" ", "_")}_shape_invalid`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) {
    fail(`${label.replaceAll(" ", "_")}_invalid`);
  }
  return value;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalize(value) {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("raw_capture_terminal_non_finite_number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        fail("raw_capture_terminal_undefined_value");
      }
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  fail("raw_capture_terminal_unsupported_value");
}

function fail(code) {
  throw new JsonCompatibilityAccountBindingRawCaptureError(code);
}
