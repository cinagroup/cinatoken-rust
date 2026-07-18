import {
  isProviderUsageReceipt,
  type ProviderUsageReceipt,
} from "./storage_gateway";

export const PROVIDER_RESPONSE_V3_PROTOCOL_VERSION = 3 as const;
export const PROVIDER_RESPONSE_V3_CONTENT_TYPE =
  "application/vnd.cinatoken.provider-response.v3+json";
export const PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT =
  "go-openai-response-v1";
export const PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT =
  "73652508abc5cb09214dde02d51d69d1d1ccc703";
export const PROVIDER_RESPONSE_V3_EGRESS_PROFILE =
  "openai-chat-completions-canary-v1";
export const MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES = 12_582_912;
export const MAX_PROVIDER_RESPONSE_V3_OPERATIONAL_ENVELOPE_BYTES = 3_200_000;
export const MAX_PROVIDER_RESPONSE_V3_BODY_BYTES = 4_194_304;
export const MAX_PROVIDER_RESPONSE_V3_HEADER_JSON_BYTES = 8_192;
export const MAX_PROVIDER_RESPONSE_V3_USAGE_RECEIPT_BYTES = 8_192;

const PROVIDER_EVIDENCE_ATTESTATION_CONTRACT =
  "cinatoken-provider-evidence-attestation-v1";
const CLIENT_RESPONSE_ATTESTATION_CONTRACT =
  "cinatoken-client-response-attestation-v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_NO_PAD_PATTERN = /^[A-Za-z0-9_-]*$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/@-]{1,128}$/;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_HEADER_VALUE_BYTES = 1_024;
const MAX_CONTENT_TYPE_BYTES = 128;

const ENVELOPE_KEYS = [
  "protocol_version",
  "identity",
  "interpretation",
  "raw",
  "client",
  "usage_receipt",
  "provider_response_evidence_sha256",
  "client_response_artifact_sha256",
] as const;
const IDENTITY_KEYS = [
  "operation_id",
  "owner_generation",
  "attempt_generation",
  "provider_operation_id",
  "request_sha256",
  "egress_profile",
  "egress_worker_version_id",
] as const;
const INTERPRETATION_KEYS = [
  "contract",
  "source_commit",
  "response_class",
  "provider_status",
  "client_status",
  "audit_status",
] as const;
const RAW_KEYS = [
  "content_type",
  "headers_json",
  "headers_length",
  "headers_sha256",
  "body_length",
  "body_sha256",
  "body_base64",
  "provider_request_id",
  "completed_at",
] as const;
const CLIENT_KEYS = [
  "content_type",
  "headers_json",
  "headers_length",
  "headers_sha256",
  "body_length",
  "body_sha256",
  "body_same_as_raw",
  "body_base64",
] as const;
const RAW_HEADER_NAMES = [
  "content-language",
  "content-type",
  "openai-request-id",
  "request-id",
  "retry-after",
  "x-request-id",
] as const;
const CLIENT_HEADER_NAMES = ["cache-control", ...RAW_HEADER_NAMES] as const;

export type ProviderResponseClassV3 =
  | "success"
  | "typed_error"
  | "http_error"
  | "invalid_body";

export interface ProviderResponseIdentityV3 {
  readonly operation_id: string;
  readonly owner_generation: number;
  readonly attempt_generation: number;
  readonly provider_operation_id: string;
  readonly request_sha256: string;
  readonly egress_profile: typeof PROVIDER_RESPONSE_V3_EGRESS_PROFILE;
  readonly egress_worker_version_id: string;
}

export interface ProviderResponseInterpretationV3 {
  readonly contract: typeof PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT;
  readonly source_commit: typeof PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT;
  readonly response_class: ProviderResponseClassV3;
  readonly provider_status: number;
  readonly client_status: number;
  readonly audit_status: number;
}

export interface ProviderResponseRawV3 {
  readonly content_type: string | null;
  readonly headers_json: string;
  readonly headers_length: number;
  readonly headers_sha256: string;
  readonly body_length: number;
  readonly body_sha256: string;
  readonly body_base64: string;
  readonly provider_request_id: string | null;
  readonly completed_at: number;
}

export interface ProviderResponseClientV3 {
  readonly content_type: "application/json";
  readonly headers_json: string;
  readonly headers_length: number;
  readonly headers_sha256: string;
  readonly body_length: number;
  readonly body_sha256: string;
  readonly body_same_as_raw: boolean;
  readonly body_base64: string | null;
}

export interface ProviderResponseEnvelopeV3 {
  readonly protocol_version: typeof PROVIDER_RESPONSE_V3_PROTOCOL_VERSION;
  readonly identity: ProviderResponseIdentityV3;
  readonly interpretation: ProviderResponseInterpretationV3;
  readonly raw: ProviderResponseRawV3;
  readonly client: ProviderResponseClientV3;
  readonly usage_receipt: ProviderUsageReceipt | null;
  readonly provider_response_evidence_sha256: string;
  readonly client_response_artifact_sha256: string;
}

export type VerifiedProviderResponseRawV3 = Omit<ProviderResponseRawV3, "body_base64">;
export type VerifiedProviderResponseClientV3 = Omit<
  ProviderResponseClientV3,
  "body_base64"
>;
export interface VerifiedProviderResponseEnvelopeV3
  extends Omit<ProviderResponseEnvelopeV3, "raw" | "client"> {
  readonly raw: VerifiedProviderResponseRawV3;
  readonly client: VerifiedProviderResponseClientV3;
}

export interface VerifiedProviderResponseV3 {
  readonly envelope: VerifiedProviderResponseEnvelopeV3;
  readonly raw_headers: Readonly<Record<string, string>>;
  readonly client_headers: Readonly<Record<string, string>>;
  readonly raw_body: Uint8Array;
  readonly client_body: Uint8Array;
  readonly usage_receipt: ProviderUsageReceipt | null;
  readonly usage_receipt_json: string | null;
  readonly usage_receipt_sha256: string | null;
}

export class ProviderResponseV3Error extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderResponseV3Error";
  }
}

/** Read and verify one completed provider-response v3 broker response. */
export async function readProviderResponseV3(
  response: Response,
  maxEnvelopeBytes = MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES,
): Promise<VerifiedProviderResponseV3> {
  if (
    !Number.isSafeInteger(maxEnvelopeBytes) ||
    maxEnvelopeBytes <= 0 ||
    maxEnvelopeBytes > MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES
  ) {
    fail("provider_response_v3_envelope_limit_invalid");
  }
  if (
    response.status !== 200 ||
    response.headers.get("content-type") !== PROVIDER_RESPONSE_V3_CONTENT_TYPE
  ) {
    await cancelResponse(response, "provider_response_v3_outer_response_invalid");
    fail("provider_response_v3_outer_response_invalid");
  }

  const declaredLength = response.headers.get("content-length");
  let expectedLength: number | null = null;
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      await cancelResponse(response, "provider_response_v3_content_length_invalid");
      fail("provider_response_v3_content_length_invalid");
    }
    expectedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(expectedLength) ||
      expectedLength > maxEnvelopeBytes
    ) {
      await cancelResponse(response, "provider_response_v3_envelope_too_large");
      fail("provider_response_v3_envelope_too_large");
    }
  }

  const bytes = await readBoundedResponseBody(
    response,
    expectedLength,
    maxEnvelopeBytes,
  );
  if (expectedLength !== null && bytes.byteLength !== expectedLength) {
    fail("provider_response_v3_content_length_mismatch");
  }
  return parseProviderResponseV3(bytes);
}

/** Verify canonical envelope bytes that have already been read with a hard bound. */
export async function parseProviderResponseV3(
  bytes: Uint8Array,
): Promise<VerifiedProviderResponseV3> {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_PROVIDER_RESPONSE_V3_ENVELOPE_BYTES
  ) {
    fail(
      bytes.byteLength === 0
        ? "provider_response_v3_envelope_empty"
        : "provider_response_v3_envelope_too_large",
    );
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    fail("provider_response_v3_envelope_noncanonical");
  }

  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    fail("provider_response_v3_envelope_json_invalid");
  }

  const envelope = parseEnvelopeShape(value);
  const canonicalEnvelopeJson = JSON.stringify(canonicalEnvelopeObject(envelope));
  if (text !== canonicalEnvelopeJson) {
    fail("provider_response_v3_envelope_noncanonical");
  }

  validateClassification(envelope.interpretation, envelope.usage_receipt);

  const [rawHeaders, clientHeaders] = await Promise.all([
    parseCanonicalHeaders(
      "raw",
      envelope.raw.headers_json,
      envelope.raw.headers_length,
      envelope.raw.headers_sha256,
      RAW_HEADER_NAMES,
    ),
    parseCanonicalHeaders(
      "client",
      envelope.client.headers_json,
      envelope.client.headers_length,
      envelope.client.headers_sha256,
      CLIENT_HEADER_NAMES,
    ),
  ]);
  validateHeaderBoundary(envelope, rawHeaders, clientHeaders);

  const { rawBody, clientBody } = await verifyBodies(envelope.raw, envelope.client);
  const receiptEvidence = await verifyUsageReceipt(envelope);
  await verifyAttestations(envelope, receiptEvidence.sha256);

  const { body_base64: _rawBodyBase64, ...rawWithoutEncoding } = envelope.raw;
  const { body_base64: _clientBodyBase64, ...clientWithoutEncoding } = envelope.client;
  const verifiedEnvelope: VerifiedProviderResponseEnvelopeV3 = {
    ...envelope,
    raw: rawWithoutEncoding,
    client: clientWithoutEncoding,
  };

  return {
    envelope: verifiedEnvelope,
    raw_headers: Object.freeze(rawHeaders),
    client_headers: Object.freeze(clientHeaders),
    raw_body: rawBody,
    client_body: clientBody,
    usage_receipt: receiptEvidence.receipt,
    usage_receipt_json: receiptEvidence.json,
    usage_receipt_sha256: receiptEvidence.sha256,
  };
}

function parseEnvelopeShape(value: unknown): ProviderResponseEnvelopeV3 {
  const envelope = requireRecord(value, "provider_response_v3_envelope_type_invalid");
  requireExactOrderedKeys(
    envelope,
    ENVELOPE_KEYS,
    "provider_response_v3_envelope_keys_invalid",
  );
  if (envelope.protocol_version !== PROVIDER_RESPONSE_V3_PROTOCOL_VERSION) {
    fail("provider_response_v3_protocol_version_invalid");
  }

  const identity = parseIdentity(envelope.identity);
  const interpretation = parseInterpretation(envelope.interpretation);
  const raw = parseRaw(envelope.raw);
  const client = parseClient(envelope.client);
  let usageReceipt: ProviderUsageReceipt | null;
  if (envelope.usage_receipt === null) {
    usageReceipt = null;
  } else if (isProviderUsageReceipt(envelope.usage_receipt)) {
    usageReceipt = envelope.usage_receipt;
  } else {
    fail("provider_response_v3_usage_receipt_invalid");
  }
  const providerEvidenceSha256 = requireSha256(
    envelope.provider_response_evidence_sha256,
    "provider_response_v3_provider_attestation_invalid",
  );
  const clientArtifactSha256 = requireSha256(
    envelope.client_response_artifact_sha256,
    "provider_response_v3_client_attestation_invalid",
  );

  return {
    protocol_version: PROVIDER_RESPONSE_V3_PROTOCOL_VERSION,
    identity,
    interpretation,
    raw,
    client,
    usage_receipt: usageReceipt,
    provider_response_evidence_sha256: providerEvidenceSha256,
    client_response_artifact_sha256: clientArtifactSha256,
  };
}

function parseIdentity(value: unknown): ProviderResponseIdentityV3 {
  const identity = requireRecord(value, "provider_response_v3_identity_type_invalid");
  requireExactOrderedKeys(
    identity,
    IDENTITY_KEYS,
    "provider_response_v3_identity_keys_invalid",
  );
  const egressProfile = requireString(
    identity.egress_profile,
    "provider_response_v3_identity_type_invalid",
  );
  if (egressProfile !== PROVIDER_RESPONSE_V3_EGRESS_PROFILE) {
    fail("provider_response_v3_egress_profile_invalid");
  }
  return {
    operation_id: requireIdentifier(
      identity.operation_id,
      "provider_response_v3_identity_type_invalid",
    ),
    owner_generation: requireNonNegativeSafeInteger(
      identity.owner_generation,
      "provider_response_v3_identity_type_invalid",
    ),
    attempt_generation: requireNonNegativeSafeInteger(
      identity.attempt_generation,
      "provider_response_v3_identity_type_invalid",
    ),
    provider_operation_id: requireIdentifier(
      identity.provider_operation_id,
      "provider_response_v3_identity_type_invalid",
    ),
    request_sha256: requireSha256(
      identity.request_sha256,
      "provider_response_v3_request_sha256_invalid",
    ),
    egress_profile: PROVIDER_RESPONSE_V3_EGRESS_PROFILE,
    egress_worker_version_id: requireIdentifier(
      identity.egress_worker_version_id,
      "provider_response_v3_identity_type_invalid",
    ),
  };
}

function parseInterpretation(value: unknown): ProviderResponseInterpretationV3 {
  const interpretation = requireRecord(
    value,
    "provider_response_v3_interpretation_type_invalid",
  );
  requireExactOrderedKeys(
    interpretation,
    INTERPRETATION_KEYS,
    "provider_response_v3_interpretation_keys_invalid",
  );
  if (
    interpretation.contract !== PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT ||
    interpretation.source_commit !== PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT
  ) {
    fail("provider_response_v3_interpreter_contract_invalid");
  }
  if (
    typeof interpretation.response_class !== "string" ||
    ![
      "success",
      "typed_error",
      "http_error",
      "invalid_body",
    ].includes(interpretation.response_class)
  ) {
    fail("provider_response_v3_response_class_invalid");
  }
  return {
    contract: PROVIDER_RESPONSE_V3_INTERPRETER_CONTRACT,
    source_commit: PROVIDER_RESPONSE_V3_INTERPRETER_SOURCE_COMMIT,
    response_class: interpretation.response_class as ProviderResponseClassV3,
    provider_status: requireHttpStatus(
      interpretation.provider_status,
      "provider_response_v3_provider_status_invalid",
    ),
    client_status: requireHttpStatus(
      interpretation.client_status,
      "provider_response_v3_client_status_invalid",
    ),
    audit_status: requireHttpStatus(
      interpretation.audit_status,
      "provider_response_v3_audit_status_invalid",
    ),
  };
}

function parseRaw(value: unknown): ProviderResponseRawV3 {
  const raw = requireRecord(value, "provider_response_v3_raw_type_invalid");
  requireExactOrderedKeys(raw, RAW_KEYS, "provider_response_v3_raw_keys_invalid");
  if (!(raw.content_type === null || typeof raw.content_type === "string")) {
    fail("provider_response_v3_raw_type_invalid");
  }
  if (!(raw.provider_request_id === null || typeof raw.provider_request_id === "string")) {
    fail("provider_response_v3_raw_type_invalid");
  }
  return {
    content_type: raw.content_type,
    headers_json: requireString(
      raw.headers_json,
      "provider_response_v3_raw_type_invalid",
    ),
    headers_length: requireNonNegativeSafeInteger(
      raw.headers_length,
      "provider_response_v3_raw_type_invalid",
    ),
    headers_sha256: requireSha256(
      raw.headers_sha256,
      "provider_response_v3_raw_headers_sha256_invalid",
    ),
    body_length: requireNonNegativeSafeInteger(
      raw.body_length,
      "provider_response_v3_raw_type_invalid",
    ),
    body_sha256: requireSha256(
      raw.body_sha256,
      "provider_response_v3_raw_body_sha256_invalid",
    ),
    body_base64: requireString(
      raw.body_base64,
      "provider_response_v3_raw_type_invalid",
    ),
    provider_request_id: raw.provider_request_id,
    completed_at: requireNonNegativeSafeInteger(
      raw.completed_at,
      "provider_response_v3_raw_type_invalid",
    ),
  };
}

function parseClient(value: unknown): ProviderResponseClientV3 {
  const client = requireRecord(value, "provider_response_v3_client_type_invalid");
  requireExactOrderedKeys(
    client,
    CLIENT_KEYS,
    "provider_response_v3_client_keys_invalid",
  );
  if (client.content_type !== "application/json") {
    fail("provider_response_v3_client_content_type_invalid");
  }
  if (typeof client.body_same_as_raw !== "boolean") {
    fail("provider_response_v3_client_type_invalid");
  }
  if (!(client.body_base64 === null || typeof client.body_base64 === "string")) {
    fail("provider_response_v3_client_type_invalid");
  }
  return {
    content_type: "application/json",
    headers_json: requireString(
      client.headers_json,
      "provider_response_v3_client_type_invalid",
    ),
    headers_length: requireNonNegativeSafeInteger(
      client.headers_length,
      "provider_response_v3_client_type_invalid",
    ),
    headers_sha256: requireSha256(
      client.headers_sha256,
      "provider_response_v3_client_headers_sha256_invalid",
    ),
    body_length: requireNonNegativeSafeInteger(
      client.body_length,
      "provider_response_v3_client_type_invalid",
    ),
    body_sha256: requireSha256(
      client.body_sha256,
      "provider_response_v3_client_body_sha256_invalid",
    ),
    body_same_as_raw: client.body_same_as_raw,
    body_base64: client.body_base64,
  };
}

function canonicalEnvelopeObject(envelope: ProviderResponseEnvelopeV3): object {
  return {
    protocol_version: envelope.protocol_version,
    identity: {
      operation_id: envelope.identity.operation_id,
      owner_generation: envelope.identity.owner_generation,
      attempt_generation: envelope.identity.attempt_generation,
      provider_operation_id: envelope.identity.provider_operation_id,
      request_sha256: envelope.identity.request_sha256,
      egress_profile: envelope.identity.egress_profile,
      egress_worker_version_id: envelope.identity.egress_worker_version_id,
    },
    interpretation: {
      contract: envelope.interpretation.contract,
      source_commit: envelope.interpretation.source_commit,
      response_class: envelope.interpretation.response_class,
      provider_status: envelope.interpretation.provider_status,
      client_status: envelope.interpretation.client_status,
      audit_status: envelope.interpretation.audit_status,
    },
    raw: {
      content_type: envelope.raw.content_type,
      headers_json: envelope.raw.headers_json,
      headers_length: envelope.raw.headers_length,
      headers_sha256: envelope.raw.headers_sha256,
      body_length: envelope.raw.body_length,
      body_sha256: envelope.raw.body_sha256,
      body_base64: envelope.raw.body_base64,
      provider_request_id: envelope.raw.provider_request_id,
      completed_at: envelope.raw.completed_at,
    },
    client: {
      content_type: envelope.client.content_type,
      headers_json: envelope.client.headers_json,
      headers_length: envelope.client.headers_length,
      headers_sha256: envelope.client.headers_sha256,
      body_length: envelope.client.body_length,
      body_sha256: envelope.client.body_sha256,
      body_same_as_raw: envelope.client.body_same_as_raw,
      body_base64: envelope.client.body_base64,
    },
    usage_receipt: envelope.usage_receipt,
    provider_response_evidence_sha256:
      envelope.provider_response_evidence_sha256,
    client_response_artifact_sha256: envelope.client_response_artifact_sha256,
  };
}

function validateClassification(
  interpretation: ProviderResponseInterpretationV3,
  receipt: ProviderUsageReceipt | null,
): void {
  const { provider_status: provider, client_status: client, audit_status: audit } =
    interpretation;
  let valid = false;
  switch (interpretation.response_class) {
    case "success":
      valid = provider === 200 && client === 200 && audit === 200;
      break;
    case "typed_error":
      valid = provider === 200 && client === 200 && audit === 500 && receipt === null;
      break;
    case "http_error":
      valid =
        provider !== 200 &&
        client === provider &&
        audit === (provider >= 400 ? provider : 500) &&
        receipt === null;
      break;
    case "invalid_body":
      valid = provider === 200 && client === 500 && audit === 500 && receipt === null;
      break;
  }
  if (!valid) fail("provider_response_v3_classification_contradiction");
}

async function parseCanonicalHeaders(
  label: "raw" | "client",
  json: string,
  declaredLength: number,
  declaredSha256: string,
  allowedNames: readonly string[],
): Promise<Record<string, string>> {
  const bytes = encodeUtf8(json);
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > MAX_PROVIDER_RESPONSE_V3_HEADER_JSON_BYTES ||
    bytes.byteLength !== declaredLength
  ) {
    fail(`provider_response_v3_${label}_headers_length_invalid`);
  }

  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    fail(`provider_response_v3_${label}_headers_json_invalid`);
  }
  const record = requireRecord(
    value,
    `provider_response_v3_${label}_headers_json_invalid`,
  );
  const keys = Object.keys(record);
  if (
    !keys.every((key) => allowedNames.includes(key)) ||
    !keys.every((key, index) => index === 0 || keys[index - 1]! < key) ||
    keys.some((key) => typeof record[key] !== "string") ||
    JSON.stringify(record) !== json
  ) {
    fail(`provider_response_v3_${label}_headers_noncanonical`);
  }
  for (const key of keys) {
    const value = record[key] as string;
    if (
      !validHeaderValue(value) ||
      (key === "content-type" && !validContentType(value)) ||
      (isRequestIdHeader(key) && !IDENTIFIER_PATTERN.test(value))
    ) {
      fail(`provider_response_v3_${label}_headers_invalid`);
    }
  }
  if ((await sha256Hex(bytes)) !== declaredSha256) {
    fail(`provider_response_v3_${label}_headers_sha256_mismatch`);
  }
  return record as Record<string, string>;
}

function validateHeaderBoundary(
  envelope: ProviderResponseEnvelopeV3,
  rawHeaders: Readonly<Record<string, string>>,
  clientHeaders: Readonly<Record<string, string>>,
): void {
  const observedContentType = rawHeaders["content-type"];
  if (
    (envelope.raw.content_type === null && observedContentType !== undefined) ||
    (envelope.raw.content_type !== null &&
      observedContentType !== envelope.raw.content_type)
  ) {
    fail("provider_response_v3_raw_content_type_contradiction");
  }
  const expectedProviderRequestId =
    rawHeaders["x-request-id"] ??
    rawHeaders["openai-request-id"] ??
    rawHeaders["request-id"] ??
    null;
  if (envelope.raw.provider_request_id !== expectedProviderRequestId) {
    fail("provider_response_v3_provider_request_id_contradiction");
  }

  const expectedClientHeaders: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json",
  };
  if (envelope.interpretation.response_class === "success") {
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (name !== "content-type") expectedClientHeaders[name] = value;
    }
  }
  const expectedEntries = Object.entries(expectedClientHeaders).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const actualEntries = Object.entries(clientHeaders);
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some(
      ([name, value], index) =>
        name !== expectedEntries[index]?.[0] || value !== expectedEntries[index]?.[1],
    )
  ) {
    fail("provider_response_v3_client_headers_contradiction");
  }
}

async function verifyBodies(
  raw: ProviderResponseRawV3,
  client: ProviderResponseClientV3,
): Promise<{ rawBody: Uint8Array; clientBody: Uint8Array }> {
  if (raw.body_length > MAX_PROVIDER_RESPONSE_V3_BODY_BYTES) {
    fail("provider_response_v3_raw_body_length_invalid");
  }
  if (client.body_length < 2 || client.body_length > MAX_PROVIDER_RESPONSE_V3_BODY_BYTES) {
    fail("provider_response_v3_client_body_length_invalid");
  }

  const rawBody = decodeBase64UrlNoPad(
    raw.body_base64,
    raw.body_length,
    "provider_response_v3_raw_body_base64_invalid",
  );
  if ((await sha256Hex(rawBody)) !== raw.body_sha256) {
    fail("provider_response_v3_raw_body_sha256_mismatch");
  }

  if (client.body_same_as_raw) {
    if (
      client.body_base64 !== null ||
      client.body_length !== raw.body_length ||
      client.body_sha256 !== raw.body_sha256
    ) {
      fail("provider_response_v3_body_deduplication_contradiction");
    }
    return { rawBody, clientBody: rawBody };
  }

  if (client.body_base64 === null) {
    fail("provider_response_v3_client_body_base64_missing");
  }
  const clientBody = decodeBase64UrlNoPad(
    client.body_base64,
    client.body_length,
    "provider_response_v3_client_body_base64_invalid",
  );
  if ((await sha256Hex(clientBody)) !== client.body_sha256) {
    fail("provider_response_v3_client_body_sha256_mismatch");
  }
  if (bytesEqual(clientBody, rawBody)) {
    fail("provider_response_v3_body_deduplication_contradiction");
  }
  return { rawBody, clientBody };
}

async function verifyUsageReceipt(
  envelope: ProviderResponseEnvelopeV3,
): Promise<{
  receipt: ProviderUsageReceipt | null;
  json: string | null;
  sha256: string | null;
}> {
  const receipt = envelope.usage_receipt;
  if (receipt === null) return { receipt: null, json: null, sha256: null };

  const json = JSON.stringify(receipt);
  const bytes = encodeUtf8(json);
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_V3_USAGE_RECEIPT_BYTES) {
    fail("provider_response_v3_usage_receipt_too_large");
  }
  const { identity, interpretation, raw } = envelope;
  if (
    receipt.operation_id !== identity.operation_id ||
    receipt.owner_generation !== identity.owner_generation ||
    receipt.attempt_generation !== identity.attempt_generation ||
    receipt.provider_operation_id !== identity.provider_operation_id ||
    receipt.request_sha256 !== identity.request_sha256 ||
    receipt.egress_profile !== identity.egress_profile ||
    receipt.egress_worker_version_id !== identity.egress_worker_version_id ||
    receipt.provider_response_status !== interpretation.provider_status ||
    receipt.provider_response_sha256 !== raw.body_sha256 ||
    receipt.provider_request_id !== raw.provider_request_id ||
    receipt.provider_completed_at !== raw.completed_at
  ) {
    fail("provider_response_v3_usage_receipt_contradiction");
  }
  return { receipt, json, sha256: await sha256Hex(bytes) };
}

async function verifyAttestations(
  envelope: ProviderResponseEnvelopeV3,
  usageReceiptSha256: string | null,
): Promise<void> {
  const providerDigestInput = {
    contract: PROVIDER_EVIDENCE_ATTESTATION_CONTRACT,
    identity: envelope.identity,
    interpretation: envelope.interpretation,
    raw: {
      content_type: envelope.raw.content_type,
      headers_length: envelope.raw.headers_length,
      headers_sha256: envelope.raw.headers_sha256,
      body_length: envelope.raw.body_length,
      body_sha256: envelope.raw.body_sha256,
      provider_request_id: envelope.raw.provider_request_id,
      completed_at: envelope.raw.completed_at,
    },
  };
  const providerDigest = await sha256Hex(
    encodeUtf8(JSON.stringify(providerDigestInput)),
  );
  if (providerDigest !== envelope.provider_response_evidence_sha256) {
    fail("provider_response_v3_provider_attestation_mismatch");
  }

  const clientDigestInput = {
    contract: CLIENT_RESPONSE_ATTESTATION_CONTRACT,
    identity: envelope.identity,
    provider_response_evidence_sha256: envelope.provider_response_evidence_sha256,
    interpretation: envelope.interpretation,
    client: {
      content_type: envelope.client.content_type,
      headers_length: envelope.client.headers_length,
      headers_sha256: envelope.client.headers_sha256,
      body_length: envelope.client.body_length,
      body_sha256: envelope.client.body_sha256,
      body_same_as_raw: envelope.client.body_same_as_raw,
    },
    usage_receipt_sha256: usageReceiptSha256,
  };
  const clientDigest = await sha256Hex(encodeUtf8(JSON.stringify(clientDigestInput)));
  if (clientDigest !== envelope.client_response_artifact_sha256) {
    fail("provider_response_v3_client_attestation_mismatch");
  }
}

function decodeBase64UrlNoPad(
  encoded: string,
  expectedLength: number,
  errorCode: string,
): Uint8Array {
  if (
    !BASE64URL_NO_PAD_PATTERN.test(encoded) ||
    encoded.length % 4 === 1 ||
    encoded.length !== base64UrlEncodedLength(expectedLength) ||
    Math.floor((encoded.length * 3) / 4) !== expectedLength
  ) {
    fail(errorCode);
  }

  const decoded = new Uint8Array(expectedLength);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    const value = base64UrlValue(encoded.charCodeAt(index));
    if (value < 0) fail(errorCode);
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outputIndex >= decoded.length) fail(errorCode);
      decoded[outputIndex] = (accumulator >> bits) & 0xff;
      outputIndex += 1;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (outputIndex !== expectedLength || accumulator !== 0) fail(errorCode);
  if (encodeBase64UrlNoPad(decoded) !== encoded) fail(errorCode);
  return decoded;
}

function encodeBase64UrlNoPad(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    chunk +=
      BASE64URL_ALPHABET[(value >> 18) & 63]! +
      BASE64URL_ALPHABET[(value >> 12) & 63]! +
      BASE64URL_ALPHABET[(value >> 6) & 63]! +
      BASE64URL_ALPHABET[value & 63]!;
    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (index < bytes.length) {
    const first = bytes[index]!;
    const second = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const value = (first << 16) | (second << 8);
    chunk +=
      BASE64URL_ALPHABET[(value >> 18) & 63]! +
      BASE64URL_ALPHABET[(value >> 12) & 63]!;
    if (index + 1 < bytes.length) {
      chunk += BASE64URL_ALPHABET[(value >> 6) & 63]!;
    }
  }
  chunks.push(chunk);
  return chunks.join("");
}

function base64UrlValue(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 45) return 62;
  if (code === 95) return 63;
  return -1;
}

function base64UrlEncodedLength(decodedLength: number): number {
  const completeTriples = Math.floor(decodedLength / 3);
  const remainder = decodedLength % 3;
  return completeTriples * 4 + (remainder === 0 ? 0 : remainder + 1);
}

async function readBoundedResponseBody(
  response: Response,
  expectedLength: number | null,
  maxEnvelopeBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  if (expectedLength !== null) {
    const bytes = new Uint8Array(expectedLength);
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.byteLength > expectedLength) {
          await reader.cancel("provider_response_v3_content_length_mismatch");
          fail("provider_response_v3_content_length_mismatch");
        }
        bytes.set(next.value, offset);
        offset += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== expectedLength) {
      fail("provider_response_v3_content_length_mismatch");
    }
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxEnvelopeBytes) {
        await reader.cancel("provider_response_v3_envelope_too_large");
        fail("provider_response_v3_envelope_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelResponse(response: Response, reason: string): Promise<void> {
  await response.body?.cancel(reason).catch(() => undefined);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function requireExactOrderedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code);
  }
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== "string") fail(code);
  return value;
}

function requireIdentifier(value: unknown, code: string): string {
  const identifier = requireString(value, code);
  if (!IDENTIFIER_PATTERN.test(identifier)) fail(code);
  return identifier;
}

function requireNonNegativeSafeInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function requireHttpStatus(value: unknown, code: string): number {
  const status = requireNonNegativeSafeInteger(value, code);
  if (status < 100 || status > 599) fail(code);
  return status;
}

function requireSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(code);
  return value;
}

function validHeaderValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HEADER_VALUE_BYTES) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function validContentType(value: string): boolean {
  if (
    value.length < 3 ||
    value.length > MAX_CONTENT_TYPE_BYTES ||
    value !== value.trim()
  ) {
    return false;
  }
  const separator = value.indexOf(";");
  const mediaType = separator === -1 ? value : value.slice(0, separator);
  const parameters = separator === -1 ? null : value.slice(separator + 1);
  const slash = mediaType.indexOf("/");
  if (
    slash <= 0 ||
    slash !== mediaType.lastIndexOf("/") ||
    slash === mediaType.length - 1 ||
    !isMediaTypeToken(mediaType.slice(0, slash)) ||
    !isMediaTypeToken(mediaType.slice(slash + 1))
  ) {
    return false;
  }
  return parameters === null ||
    (parameters.length > 0 && validPrintableAscii(parameters));
}

function isMediaTypeToken(value: string): boolean {
  return value.length > 0 && [...value].every((character) =>
    /[A-Za-z0-9!#$&^_.+-]/.test(character),
  );
}

function validPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isRequestIdHeader(name: string): boolean {
  return name === "openai-request-id" || name === "request-id" || name === "x-request-id";
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function fail(code: string): never {
  throw new ProviderResponseV3Error(code);
}
