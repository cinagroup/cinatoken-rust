import {
  buildJsonCompatibilityDeploymentTransitionSourceAuthentication,
  validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest,
  type JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  type JsonCompatibilityDeploymentTransitionSourceAuthenticationV2,
} from "../../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT,
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
  JsonCompatibilitySourceAuthenticationProtocolError,
  buildJsonCompatibilitySourceVerifierPolicy,
  sourceAuthenticationBundleKey,
  sourceAuthenticationRevocationKey,
  sourceSignatureSigningPayload,
  validateJsonCompatibilitySourceAuthenticationBundle,
  type JsonCompatibilitySourceAuthenticationBundleV1,
} from "../../../tools/container_runtime_json_compatibility_source_authentication.mjs";

import {
  canonicalJson,
  sha256Bytes,
  sha256Canonical,
  toArrayBuffer,
} from "./canonical";

const EXPECTED_SERVICE_NAME =
  "cinatoken-container-runtime-json-compatibility-source-verifier-staging";
const EXPECTED_KEY_PREFIX =
  "container-runtime/json-compatibility/source-authentication/v2/sha256";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 200_000;
const MAX_JSON_STRING_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface JsonCompatibilitySourceVerifierEnv {
  readonly CF_VERSION_METADATA: { readonly id: string };
  readonly SOURCE_AUTHENTICATION_BUCKET: R2Bucket;
  readonly ENVIRONMENT: string;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED: string;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED: string;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER_PROFILE_VERSION: string;
  readonly JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME: string;
  readonly JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX: string;
  readonly JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER: string;
  readonly JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE: string;
  readonly JSON_COMPATIBILITY_SOURCE_CURRENT_KID: string;
  readonly JSON_COMPATIBILITY_SOURCE_CURRENT_SPKI_SHA256: string;
  readonly JSON_COMPATIBILITY_SOURCE_PREVIOUS_KID: string;
  readonly JSON_COMPATIBILITY_SOURCE_PREVIOUS_SPKI_SHA256: string;
  readonly JSON_COMPATIBILITY_SOURCE_PREVIOUS_ACCEPT_UNTIL: string;
}

export interface SourceVerifierRuntime {
  now(): number;
}

const DEFAULT_RUNTIME: SourceVerifierRuntime = {
  now: () => Math.floor(Date.now() / 1000),
};

interface TrustKey {
  readonly keyId: string;
  readonly spkiSha256: string;
  readonly acceptUntil: number | null;
}

interface VerifierConfiguration {
  readonly serviceName: string;
  readonly versionId: string;
  readonly keyPrefix: string;
  readonly current: TrustKey;
  readonly previous: TrustKey | null;
  readonly sourceVerifierPolicySha256: string;
  readonly verifierIdentitySha256: string;
}

interface LoadedBundle {
  readonly bundle: JsonCompatibilitySourceAuthenticationBundleV1;
  readonly bundleKey: string;
  readonly bodySha256: string;
  readonly bytes: number;
  readonly etag: string;
  readonly version: string;
}

class SourceRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SourceRejectedError";
  }
}

class SourceAmbiguousError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SourceAmbiguousError";
  }
}

export class JsonCompatibilitySourceVerifierWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JsonCompatibilitySourceVerifierWorkerError";
  }
}

export async function authenticateTransitionSource(
  env: JsonCompatibilitySourceVerifierEnv,
  input: unknown,
  runtime: SourceVerifierRuntime = DEFAULT_RUNTIME,
): Promise<JsonCompatibilityDeploymentTransitionSourceAuthenticationV2> {
  const now = runtimeNow(runtime);
  const configuration = await requireConfiguration(env);
  const request = parseRequest(input);
  try {
    if (!constantTimeHexEqual(
      request.sourceEvidence.sourceVerifierPolicySha256,
      configuration.sourceVerifierPolicySha256,
    )) throw new SourceRejectedError("source_verifier_policy_mismatch");
    const loaded = await loadBundle(env, configuration, request, now);
    const signerSpkiSha256 = await verifyBundleSignature(
      env,
      configuration,
      loaded,
      now,
    );
    const evidenceSha256 = await sha256Canonical({
      schemaVersion: 1,
      contract:
        "cinatoken-container-runtime-json-compatibility-source-verification-evidence-v1",
      classification: "authenticated",
      requestSha256: request.sourceAuthenticationRequestSha256,
      bundleKey: loaded.bundleKey,
      bundleSha256: loaded.bundle.bundleSha256,
      bodySha256: loaded.bodySha256,
      bytes: loaded.bytes,
      objectEtagSha256: await sha256Bytes(
        new TextEncoder().encode(loaded.etag),
      ),
      objectVersionSha256: await sha256Bytes(
        new TextEncoder().encode(loaded.version),
      ),
      signerSpkiSha256,
      verifierIdentitySha256: configuration.verifierIdentitySha256,
    });
    return buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
      sourceAuthenticationRequest: request,
      classification: "authenticated",
      reasonCode: null,
      verifierIdentitySha256: configuration.verifierIdentitySha256,
      evidenceSha256,
      verifiedAt: now,
    });
  } catch (error) {
    if (
      error instanceof JsonCompatibilitySourceVerifierWorkerError
      || !(error instanceof Error)
    ) throw error;
    const classification = error instanceof SourceAmbiguousError
      ? "ambiguous" as const
      : "rejected" as const;
    const reasonCode = error instanceof SourceAmbiguousError
        || error instanceof SourceRejectedError
      ? error.code
      : error instanceof JsonCompatibilitySourceAuthenticationProtocolError
        ? error.code
        : "source_bundle_invalid";
    return buildJsonCompatibilityDeploymentTransitionSourceAuthentication({
      sourceAuthenticationRequest: request,
      classification,
      reasonCode,
      verifierIdentitySha256: configuration.verifierIdentitySha256,
      evidenceSha256: await sha256Canonical({
        schemaVersion: 1,
        contract:
          "cinatoken-container-runtime-json-compatibility-source-verification-failure-v1",
        classification,
        reasonCode,
        requestSha256: request.sourceAuthenticationRequestSha256,
        verifierIdentitySha256: configuration.verifierIdentitySha256,
      }),
      verifiedAt: now,
    });
  }
}

async function loadBundle(
  env: JsonCompatibilitySourceVerifierEnv,
  configuration: VerifierConfiguration,
  request: JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2,
  now: number,
): Promise<LoadedBundle> {
  const envelopeSha256 = requireSha256(
    request.sourceEvidence.sourceSignatureEnvelopeSha256,
    "source_signature_envelope_digest_invalid",
  );
  const bundleKey = sourceAuthenticationBundleKey(
    envelopeSha256,
    configuration.keyPrefix,
  );
  let head: R2Object | null;
  let object: R2ObjectBody | null;
  try {
    head = await env.SOURCE_AUTHENTICATION_BUCKET.head(bundleKey);
    if (head === null) throw new SourceRejectedError("source_bundle_missing");
    if (head.size < 2 || head.size > MAX_BUNDLE_BYTES) {
      throw new SourceRejectedError("source_bundle_size_invalid");
    }
    object = await env.SOURCE_AUTHENTICATION_BUCKET.get(bundleKey);
  } catch (error) {
    if (error instanceof SourceRejectedError) throw error;
    throw new SourceAmbiguousError("source_bundle_read_unavailable");
  }
  if (object === null) {
    throw new SourceAmbiguousError("source_bundle_head_get_drift");
  }
  if (
    object.size !== head.size
    || object.version !== head.version
    || object.etag !== head.etag
  ) throw new SourceAmbiguousError("source_bundle_head_get_drift");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new SourceAmbiguousError("source_bundle_body_unavailable");
  }
  if (bytes.byteLength !== object.size || bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new SourceAmbiguousError("source_bundle_body_size_drift");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new SourceRejectedError("source_bundle_utf8_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    validateJsonShape(parsed);
  } catch (error) {
    if (error instanceof SourceRejectedError) throw error;
    throw new SourceRejectedError("source_bundle_json_invalid");
  }
  let canonical: string;
  try {
    canonical = `${canonicalJson(parsed)}\n`;
  } catch {
    throw new SourceRejectedError("source_bundle_json_invalid");
  }
  if (text !== canonical) {
    throw new SourceRejectedError("source_bundle_not_canonical");
  }
  const bundle = validateJsonCompatibilitySourceAuthenticationBundle(
    request,
    parsed,
    { now, requireUsableWindow: true },
  );
  validateObjectMetadata(object, bundle, envelopeSha256);
  return {
    bundle,
    bundleKey,
    bodySha256: await sha256Bytes(bytes),
    bytes: bytes.byteLength,
    etag: object.etag,
    version: object.version,
  };
}

async function verifyBundleSignature(
  env: JsonCompatibilitySourceVerifierEnv,
  configuration: VerifierConfiguration,
  loaded: LoadedBundle,
  now: number,
): Promise<string> {
  const envelope = loaded.bundle.sourceSignatureEnvelope;
  const selected = selectTrustKey(configuration, envelope.subject.keyId, now);
  const spki = decodeBase64url(envelope.signerSpkiBase64url, 1, 512);
  const signerSpkiSha256 = await sha256Bytes(spki);
  if (!constantTimeHexEqual(signerSpkiSha256, selected.spkiSha256)) {
    throw new SourceRejectedError("source_signer_spki_mismatch");
  }
  const revocationKey = sourceAuthenticationRevocationKey(
    signerSpkiSha256,
    configuration.keyPrefix,
  );
  await requireNotRevoked(env.SOURCE_AUTHENTICATION_BUCKET, revocationKey);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(spki),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    throw new SourceAmbiguousError("source_signature_runtime_unavailable");
  }
  const signature = decodeBase64url(envelope.signatureBase64url, 64, 64);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      toArrayBuffer(signature),
      toArrayBuffer(sourceSignatureSigningPayload(envelope.subject)),
    );
  } catch {
    throw new SourceAmbiguousError("source_signature_runtime_unavailable");
  }
  if (!valid) throw new SourceRejectedError("source_signature_invalid");
  await requireNotRevoked(env.SOURCE_AUTHENTICATION_BUCKET, revocationKey);
  return signerSpkiSha256;
}

async function requireNotRevoked(bucket: R2Bucket, key: string): Promise<void> {
  let marker: R2Object | null;
  try {
    marker = await bucket.head(key);
  } catch {
    throw new SourceAmbiguousError("source_revocation_state_unavailable");
  }
  if (marker !== null) throw new SourceRejectedError("source_signer_revoked");
}

function parseRequest(
  input: unknown,
): JsonCompatibilityDeploymentTransitionSourceAuthenticationRequestV2 {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(canonicalJson(input)).byteLength;
  } catch {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "invalid_source_authentication_request",
    );
  }
  if (bytes < 2 || bytes > MAX_REQUEST_BYTES) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_authentication_request_too_large",
    );
  }
  try {
    return validateJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest(
      input,
    );
  } catch {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "invalid_source_authentication_request",
    );
  }
}

async function requireConfiguration(
  env: JsonCompatibilitySourceVerifierEnv,
): Promise<VerifierConfiguration> {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_SOURCE_VERIFIER_ENABLED !== "true"
    || env.JSON_COMPATIBILITY_SOURCE_VERIFIER_R2_READ_ENABLED !== "true"
    || env.JSON_COMPATIBILITY_SOURCE_VERIFIER_PROFILE_VERSION !== "1"
    || env.JSON_COMPATIBILITY_SOURCE_VERIFIER_SERVICE_NAME
      !== EXPECTED_SERVICE_NAME
    || env.JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX !== EXPECTED_KEY_PREFIX
    || env.JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER
      !== JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER
    || env.JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE
      !== JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE
  ) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_disabled",
    );
  }
  if (
    env.CF_VERSION_METADATA === null
    || typeof env.CF_VERSION_METADATA !== "object"
    || typeof env.CF_VERSION_METADATA.id !== "string"
    || !KEY_ID.test(env.CF_VERSION_METADATA.id)
    || env.SOURCE_AUTHENTICATION_BUCKET === null
    || typeof env.SOURCE_AUTHENTICATION_BUCKET !== "object"
    || typeof env.SOURCE_AUTHENTICATION_BUCKET.head !== "function"
    || typeof env.SOURCE_AUTHENTICATION_BUCKET.get !== "function"
  ) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_binding_invalid",
    );
  }
  const current = trustKey(
    env.JSON_COMPATIBILITY_SOURCE_CURRENT_KID,
    env.JSON_COMPATIBILITY_SOURCE_CURRENT_SPKI_SHA256,
    null,
  );
  const previousValues = [
    env.JSON_COMPATIBILITY_SOURCE_PREVIOUS_KID,
    env.JSON_COMPATIBILITY_SOURCE_PREVIOUS_SPKI_SHA256,
    env.JSON_COMPATIBILITY_SOURCE_PREVIOUS_ACCEPT_UNTIL,
  ];
  const previousEmpty = previousValues.every((value) => value === "");
  if (!previousEmpty && previousValues.some((value) => value === "")) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_trust_invalid",
    );
  }
  const previous = previousEmpty
    ? null
    : trustKey(
      previousValues[0]!,
      previousValues[1]!,
      parsePositiveInteger(previousValues[2]!),
    );
  if (
    previous !== null
    && (
      previous.keyId === current.keyId
      || constantTimeHexEqual(previous.spkiSha256, current.spkiSha256)
    )
  ) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_trust_invalid",
    );
  }
  const identity = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-source-verifier-identity-v1",
    serviceName: EXPECTED_SERVICE_NAME,
    versionId: env.CF_VERSION_METADATA.id,
    profileVersion: 1,
    keyPrefix: EXPECTED_KEY_PREFIX,
    current,
    previous,
  };
  const policy = buildJsonCompatibilitySourceVerifierPolicy({
    serviceName: EXPECTED_SERVICE_NAME,
    profileVersion: 1,
    keyPrefix: EXPECTED_KEY_PREFIX,
    issuer: JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
    audience: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
    current: {
      keyId: current.keyId,
      spkiSha256: current.spkiSha256,
    },
    previous: previous === null
      ? null
      : {
        keyId: previous.keyId,
        spkiSha256: previous.spkiSha256,
        acceptUntil: previous.acceptUntil!,
      },
  });
  return {
    serviceName: EXPECTED_SERVICE_NAME,
    versionId: env.CF_VERSION_METADATA.id,
    keyPrefix: EXPECTED_KEY_PREFIX,
    current,
    previous,
    sourceVerifierPolicySha256: policy.sourceVerifierPolicySha256,
    verifierIdentitySha256: await sha256Canonical(identity),
  };
}

function trustKey(
  keyId: unknown,
  spkiSha256: unknown,
  acceptUntil: number | null,
): TrustKey {
  if (
    typeof keyId !== "string"
    || !KEY_ID.test(keyId)
    || typeof spkiSha256 !== "string"
    || !SHA256.test(spkiSha256)
  ) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_trust_invalid",
    );
  }
  return { keyId, spkiSha256, acceptUntil };
}

function selectTrustKey(
  configuration: VerifierConfiguration,
  keyId: string,
  now: number,
): TrustKey {
  if (keyId === configuration.current.keyId) return configuration.current;
  if (
    configuration.previous !== null
    && keyId === configuration.previous.keyId
    && configuration.previous.acceptUntil !== null
    && now <= configuration.previous.acceptUntil
  ) return configuration.previous;
  throw new SourceRejectedError("source_signer_key_untrusted");
}

function validateObjectMetadata(
  object: R2Object,
  bundle: JsonCompatibilitySourceAuthenticationBundleV1,
  envelopeSha256: string,
): void {
  if (object.httpMetadata?.contentType !== "application/json") {
    throw new SourceRejectedError("source_bundle_content_type_invalid");
  }
  const expected = {
    contract: JSON_COMPATIBILITY_SOURCE_AUTHENTICATION_BUNDLE_CONTRACT,
    bundleSha256: bundle.bundleSha256,
    sourceSignatureEnvelopeSha256: envelopeSha256,
  };
  if (canonicalJson(object.customMetadata ?? {}) !== canonicalJson(expected)) {
    throw new SourceRejectedError("source_bundle_metadata_invalid");
  }
}

function validateJsonShape(root: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new SourceRejectedError("source_bundle_json_shape_invalid");
    }
    if (typeof current.value === "string") {
      if (
        new TextEncoder().encode(current.value).byteLength
          > MAX_JSON_STRING_BYTES
      ) throw new SourceRejectedError("source_bundle_json_shape_invalid");
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function decodeBase64url(
  value: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new SourceRejectedError("source_signature_encoding_invalid");
  }
  let decoded: Uint8Array;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    decoded = Uint8Array.from(
      atob(`${normalized}${padding}`),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new SourceRejectedError("source_signature_encoding_invalid");
  }
  if (decoded.length < minimum || decoded.length > maximum) {
    throw new SourceRejectedError("source_signature_encoding_invalid");
  }
  return decoded;
}

function requireSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new SourceRejectedError(code);
  }
  return value;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_trust_invalid",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_trust_invalid",
    );
  }
  return parsed;
}

function runtimeNow(runtime: SourceVerifierRuntime): number {
  const value = runtime.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JsonCompatibilitySourceVerifierWorkerError(
      "source_verifier_clock_invalid",
    );
  }
  return value;
}
