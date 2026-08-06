import {
  JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME,
  buildJsonCompatibilitySourcePublicationWriteReceipt,
  sourcePublicationBundleBody,
  validateJsonCompatibilitySourcePublicationPacket,
  type JsonCompatibilitySourcePublicationWriteReceiptV1,
} from "../../../tools/container_runtime_json_compatibility_source_publication.mjs";

const EXPECTED_KEY_PREFIX =
  "container-runtime/json-compatibility/source-authentication/v3/sha256";
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type PublisherVariableBinding =
  | "ENVIRONMENT"
  | "JSON_COMPATIBILITY_SOURCE_PUBLISHER_ENABLED"
  | "JSON_COMPATIBILITY_SOURCE_PUBLISHER_R2_WRITE_ENABLED"
  | "JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME"
  | "JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX"
  | "JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_POLICY_SHA256"
  | "JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_IDENTITY_SHA256";

export type JsonCompatibilitySourcePublisherEnv = Omit<
  JsonCompatibilitySourcePublisherGeneratedEnv,
  PublisherVariableBinding
> & Readonly<Record<PublisherVariableBinding, string>>;

export interface SourcePublisherRuntime {
  now(): number;
}

const DEFAULT_RUNTIME: SourcePublisherRuntime = {
  now: () => Math.floor(Date.now() / 1000),
};

interface PublisherConfiguration {
  readonly serviceName:
    typeof JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME;
  readonly versionId: string;
  readonly expectedVerifierPolicySha256: string;
  readonly expectedVerifierIdentitySha256: string;
}

export class JsonCompatibilitySourcePublisherWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "JsonCompatibilitySourcePublisherWorkerError";
  }
}

export async function publishSourceBundle(
  env: JsonCompatibilitySourcePublisherEnv,
  input: unknown,
  runtime: SourcePublisherRuntime = DEFAULT_RUNTIME,
): Promise<JsonCompatibilitySourcePublicationWriteReceiptV1> {
  const configuration = requireConfiguration(env);
  const now = runtimeNow(runtime);
  let packet;
  try {
    packet = validateJsonCompatibilitySourcePublicationPacket(input, {
      now,
      requireUsableWindow: true,
    });
  } catch {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_packet_invalid",
    );
  }
  if (
    packet.sourceAuthenticationRequest.sourceEvidence
      .sourceVerifierPolicySha256
      !== configuration.expectedVerifierPolicySha256
  ) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_verifier_policy_mismatch",
    );
  }
  if (
    packet.sourceAuthenticationRequest.sourceEvidence
      .sourceVerifierIdentitySha256
      !== configuration.expectedVerifierIdentitySha256
  ) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_verifier_identity_mismatch",
    );
  }

  const bytes = new TextEncoder().encode(
    sourcePublicationBundleBody(packet.bundle),
  );
  const digest = await sha256(bytes);
  if (
    bytes.byteLength !== packet.bodyByteLength
    || digest.hex !== packet.bodySha256
  ) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_body_mismatch",
    );
  }

  let created: R2Object | null;
  try {
    created = await env.SOURCE_AUTHENTICATION_BUCKET.put(
      packet.bundleKey,
      bytes,
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          contract: packet.objectMetadata.contract,
          bundleSha256: packet.objectMetadata.bundleSha256,
          sourceSignatureEnvelopeSha256:
            packet.objectMetadata.sourceSignatureEnvelopeSha256,
        },
        sha256: digest.bytes,
      },
    );
  } catch {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_write_ambiguous",
    );
  }
  if (created === null) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_bundle_key_occupied",
    );
  }
  if (
    created.key !== packet.bundleKey
    || created.size !== packet.bodyByteLength
    || typeof created.version !== "string"
    || created.version.length < 1
    || typeof created.etag !== "string"
    || created.etag.length < 1
  ) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publication_write_response_ambiguous",
    );
  }
  return buildJsonCompatibilitySourcePublicationWriteReceipt({
    publisherServiceName: configuration.serviceName,
    publisherVersionId: configuration.versionId,
    sourceAuthenticationRequestSha256:
      packet.sourceAuthenticationRequest.sourceAuthenticationRequestSha256,
    bundleKey: packet.bundleKey,
    bundleSha256: packet.bundleSha256,
    bodySha256: packet.bodySha256,
    bodyByteLength: packet.bodyByteLength,
    sourceSignatureEnvelopeSha256:
      packet.sourceSignatureEnvelopeSha256,
    objectVersionSha256: (await sha256(
      new TextEncoder().encode(created.version),
    )).hex,
    objectEtagSha256: (await sha256(
      new TextEncoder().encode(created.etag),
    )).hex,
    publishedAt: now,
  });
}

function requireConfiguration(
  env: JsonCompatibilitySourcePublisherEnv,
): PublisherConfiguration {
  if (
    env.ENVIRONMENT !== "staging"
    || env.JSON_COMPATIBILITY_SOURCE_PUBLISHER_ENABLED !== "true"
    || env.JSON_COMPATIBILITY_SOURCE_PUBLISHER_R2_WRITE_ENABLED !== "true"
    || env.JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME
      !== JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME
    || env.JSON_COMPATIBILITY_SOURCE_BUNDLE_KEY_PREFIX !== EXPECTED_KEY_PREFIX
  ) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publisher_disabled",
    );
  }
  if (
    env.CF_VERSION_METADATA === null
    || typeof env.CF_VERSION_METADATA !== "object"
    || typeof env.CF_VERSION_METADATA.id !== "string"
    || !SAFE_TOKEN.test(env.CF_VERSION_METADATA.id)
    || env.SOURCE_AUTHENTICATION_BUCKET === null
    || typeof env.SOURCE_AUTHENTICATION_BUCKET !== "object"
    || typeof env.SOURCE_AUTHENTICATION_BUCKET.put !== "function"
  ) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publisher_binding_invalid",
    );
  }
  const expectedVerifierPolicySha256 = requireNonPlaceholderSha256(
    env.JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_POLICY_SHA256,
    "source_publisher_verifier_policy_invalid",
  );
  const expectedVerifierIdentitySha256 = requireNonPlaceholderSha256(
    env.JSON_COMPATIBILITY_SOURCE_PUBLISHER_EXPECTED_VERIFIER_IDENTITY_SHA256,
    "source_publisher_verifier_identity_invalid",
  );
  return {
    serviceName: JSON_COMPATIBILITY_SOURCE_PUBLISHER_SERVICE_NAME,
    versionId: env.CF_VERSION_METADATA.id,
    expectedVerifierPolicySha256,
    expectedVerifierIdentitySha256,
  };
}

function requireNonPlaceholderSha256(value: string, code: string): string {
  if (!SHA256.test(value) || /^0{64}$/u.test(value)) {
    throw new JsonCompatibilitySourcePublisherWorkerError(code);
  }
  return value;
}

function runtimeNow(runtime: SourcePublisherRuntime): number {
  const now = runtime.now();
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new JsonCompatibilitySourcePublisherWorkerError(
      "source_publisher_clock_invalid",
    );
  }
  return now;
}

async function sha256(
  value: Uint8Array,
): Promise<{ readonly bytes: ArrayBuffer; readonly hex: string }> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer,
  );
  return {
    bytes,
    hex: [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}
