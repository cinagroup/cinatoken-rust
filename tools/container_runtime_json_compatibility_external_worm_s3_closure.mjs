import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
  canonicalJsonCompatibilityExternalWormS3Json as canonicalJson,
  sha256JsonCompatibilityExternalWormS3Bytes as sha256Bytes,
  sha256JsonCompatibilityExternalWormS3Canonical as sha256Canonical,
  sha256JsonCompatibilityExternalWormS3Text as sha256Text,
  validateJsonCompatibilityExternalWormS3ReadbackObservation,
  validateJsonCompatibilityExternalWormS3WriterObservation,
} from "./container_runtime_json_compatibility_external_worm_s3_observation.mjs";

export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-identity-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_BACKEND_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-backend-identity-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_NAMESPACE_IDENTITY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-namespace-identity-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBJECT_BINDING_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-object-binding-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLOSURE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-s3-c2-binding-closure-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLOSURE_DECISION_SCOPE =
  "amazon-s3-provider-observation-to-external-worm-c2-evidence-binding-only";

const C2_POLICY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-policy-v1";
const C2_PASS_ROOT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-pass-root-v1";
const C2_DESCRIPTOR_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-descriptor-v1";
const C2_MANIFEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-manifest-v1";
const C2_OBJECT_OBSERVATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-observation-v1";
const C2_WRITE_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-write-observation-subject-v1";
const C2_READBACK_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-readback-observation-subject-v1";
const C2_ATTESTATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-attestation-envelope-v1";
const C2_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-evidence-v1";
const C2_WRITER_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-external-worm-writer-attestation-v1\n";
const C2_READBACK_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-external-worm-independent-readback-attestation-v1\n";
const MAX_OBJECT_COUNT = 512;
const SHA256 = /^[0-9a-f]{64}$/;
const REGION = /^(?=.{3,64}$)(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const IDENTITY_INPUT_KEYS = Object.freeze([
  "provider", "region", "bucketNameSha256", "expectedBucketOwnerSha256",
  "objectKeySha256s",
]);
const IDENTITY_KEYS = Object.freeze([
  "schemaVersion", "contract", "provider", "region", "bucketNameSha256",
  "expectedBucketOwnerSha256", "objectKeySha256s", "objectKeySetSha256",
  "objectCount", "backendIdentitySha256", "namespaceIdentitySha256",
  "identitySha256",
]);
const BINDING_KEYS = Object.freeze([
  "schemaVersion", "contract", "provider", "region", "bucketNameSha256",
  "expectedBucketOwnerSha256", "objectDescriptorSha256", "objectKeySha256",
  "writerProviderObservationSha256", "readerProviderObservationSha256",
  "c2WriteObjectObservationSha256", "c2ReadbackObjectObservationSha256",
  "versionId", "versionIdSha256", "eTag", "eTagSha256",
  "checksumSha256Base64", "bodySha256", "byteLength", "contentType",
  "metadataSha256", "writerRetainUntil", "writerRetainUntilEpochSeconds",
  "readbackRetainUntil", "readbackRetainUntilEpochSeconds",
  "writerObservedAt", "writerObservedAtEpochSeconds", "readbackObservedAt",
  "readbackObservedAtEpochSeconds", "writerProviderRequestIdSha256",
  "readerBucketVersioningRequestIdSha256",
  "readerBucketObjectLockRequestIdSha256", "readerObjectRequestIdSha256",
  "readerRetentionRequestIdSha256", "readerProviderRequestSetSha256",
  "writerCredentialIdSha256", "readerCredentialIdSha256",
  "readerWriterCredentialIdSha256", "objectBindingSha256",
]);
const CLOSURE_KEYS = Object.freeze([
  "schemaVersion", "contract", "kind", "provider", "decisionScope",
  "authorizesC2Closure", "archiveEvidenceSha256", "archivePolicySha256",
  "archiveManifestSha256", "identity", "writerCredentialIdSha256",
  "readerCredentialIdSha256", "rawWriterObservations",
  "rawReadbackObservations", "writerObservationSetSha256",
  "readbackObservationSetSha256", "bindings", "objectBindingSetSha256",
  "objectKeySetSha256", "objectCount", "closureSha256",
]);

export class JsonCompatibilityExternalWormS3ClosureError extends Error {
  constructor(code) {
    super(code);
    this.name = "JsonCompatibilityExternalWormS3ClosureError";
    this.code = code;
  }
}

export async function deriveJsonCompatibilityExternalWormS3ArchiveIdentities(
  input,
) {
  const value = record(input, "identity_input_invalid");
  exactKeys(value, IDENTITY_INPUT_KEYS, "identity_input_keys_invalid");
  equal(value.provider, JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER, "identity_provider_invalid");
  if (typeof value.region !== "string" || !REGION.test(value.region)) {
    fail("identity_region_invalid");
  }
  sha256(value.bucketNameSha256, "identity_bucket_invalid");
  sha256(value.expectedBucketOwnerSha256, "identity_owner_invalid");
  const objectKeySha256s = normalizeDigestSet(
    value.objectKeySha256s,
    "identity_object_key_set_invalid",
  );
  const backendSubject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_BACKEND_IDENTITY_CONTRACT,
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: value.region,
    bucketNameSha256: value.bucketNameSha256,
    expectedBucketOwnerSha256: value.expectedBucketOwnerSha256,
  };
  const backendIdentitySha256 = await sha256Canonical(backendSubject);
  const objectKeySetSha256 = await sha256Canonical(objectKeySha256s);
  const namespaceSubject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_NAMESPACE_IDENTITY_CONTRACT,
    backendIdentitySha256,
    objectKeySha256s,
    objectKeySetSha256,
    objectCount: objectKeySha256s.length,
  };
  const namespaceIdentitySha256 = await sha256Canonical(namespaceSubject);
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_IDENTITY_CONTRACT,
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: value.region,
    bucketNameSha256: value.bucketNameSha256,
    expectedBucketOwnerSha256: value.expectedBucketOwnerSha256,
    objectKeySha256s,
    objectKeySetSha256,
    objectCount: objectKeySha256s.length,
    backendIdentitySha256,
    namespaceIdentitySha256,
  };
  return {
    ...subject,
    identitySha256: await sha256Canonical(subject),
  };
}

export async function buildJsonCompatibilityExternalWormS3Closure({
  archiveEvidence,
  target,
  writerObservations,
  readbackObservations,
}) {
  const c2 = await verifyC2Evidence(archiveEvidence);
  const identity = await deriveJsonCompatibilityExternalWormS3ArchiveIdentities(
    target,
  );
  equal(
    c2.policy.backendIdentitySha256,
    identity.backendIdentitySha256,
    "policy_backend_identity_mismatch",
  );
  equal(
    c2.policy.namespaceIdentitySha256,
    identity.namespaceIdentitySha256,
    "policy_namespace_identity_mismatch",
  );
  const descriptorKeys = c2.manifest.objects.map(
    (value) => value.objectKeySha256,
  );
  canonicalEqual(
    descriptorKeys,
    identity.objectKeySha256s,
    "identity_manifest_object_set_mismatch",
  );
  const rawWriterObservations = await normalizeObservationSet(
    writerObservations,
    identity.objectKeySha256s,
    validateJsonCompatibilityExternalWormS3WriterObservation,
    "writer",
  );
  const rawReadbackObservations = await normalizeObservationSet(
    readbackObservations,
    identity.objectKeySha256s,
    validateJsonCompatibilityExternalWormS3ReadbackObservation,
    "readback",
  );
  assertUniformTarget(rawWriterObservations, identity);
  assertUniformTarget(rawReadbackObservations, identity);
  const writerCredentialIdSha256 = oneCredential(
    rawWriterObservations,
    "writer_credential_set_invalid",
  );
  const readerCredentialIdSha256 = oneCredential(
    rawReadbackObservations,
    "reader_credential_set_invalid",
  );
  equal(
    writerCredentialIdSha256,
    c2.policy.writer.credentialIdSha256,
    "policy_writer_credential_mismatch",
  );
  equal(
    readerCredentialIdSha256,
    c2.policy.readback.credentialIdSha256,
    "policy_reader_credential_mismatch",
  );
  if (writerCredentialIdSha256 === readerCredentialIdSha256) {
    fail("writer_reader_credential_reuse");
  }
  for (const value of rawReadbackObservations) {
    equal(
      value.writerCredentialIdSha256,
      writerCredentialIdSha256,
      "reader_writer_credential_reference_mismatch",
    );
  }
  const writerMap = mapByKey(rawWriterObservations);
  const readerMap = mapByKey(rawReadbackObservations);
  const descriptorMap = mapByKey(c2.manifest.objects);
  const c2WriteMap = mapByKey(c2.writeSubject.observations);
  const c2ReadbackMap = mapByKey(c2.readbackSubject.observations);
  const bindings = [];
  for (const objectKeySha256 of identity.objectKeySha256s) {
    bindings.push(await buildObjectBinding({
      identity,
      descriptor: descriptorMap.get(objectKeySha256),
      writer: writerMap.get(objectKeySha256),
      reader: readerMap.get(objectKeySha256),
      c2Write: c2WriteMap.get(objectKeySha256),
      c2Readback: c2ReadbackMap.get(objectKeySha256),
    }));
  }
  rejectAllProviderRequestIdReuse(bindings);
  const writerObservationSetSha256 = await sha256Canonical(
    rawWriterObservations,
  );
  const readbackObservationSetSha256 = await sha256Canonical(
    rawReadbackObservations,
  );
  equal(
    c2.writeSubject.providerObservationSetSha256,
    writerObservationSetSha256,
    "c2_writer_provider_observation_set_mismatch",
  );
  equal(
    c2.readbackSubject.providerObservationSetSha256,
    readbackObservationSetSha256,
    "c2_readback_provider_observation_set_mismatch",
  );
  const objectBindingSetSha256 = await sha256Canonical(bindings);
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLOSURE_CONTRACT,
    kind:
      "container-runtime-json-compatibility-external-worm-s3-c2-binding-closure",
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    decisionScope:
      JSON_COMPATIBILITY_EXTERNAL_WORM_S3_CLOSURE_DECISION_SCOPE,
    authorizesC2Closure: false,
    archiveEvidenceSha256: c2.evidence.archiveEvidenceSha256,
    archivePolicySha256: c2.policy.archivePolicySha256,
    archiveManifestSha256: c2.manifest.archiveManifestSha256,
    identity,
    writerCredentialIdSha256,
    readerCredentialIdSha256,
    rawWriterObservations,
    rawReadbackObservations,
    writerObservationSetSha256,
    readbackObservationSetSha256,
    bindings,
    objectBindingSetSha256,
    objectKeySetSha256: identity.objectKeySetSha256,
    objectCount: identity.objectCount,
  };
  return {
    ...subject,
    closureSha256: await sha256Canonical(subject),
  };
}

export async function validateJsonCompatibilityExternalWormS3Closure(
  archiveEvidence,
  input,
) {
  const value = record(input, "closure_invalid");
  exactKeys(value, CLOSURE_KEYS, "closure_keys_invalid");
  const identity = await validateIdentity(value.identity);
  if (!Array.isArray(value.bindings) || value.bindings.length !== identity.objectCount) {
    fail("closure_binding_set_invalid");
  }
  for (const binding of value.bindings) await validateBinding(binding);
  sha256(value.closureSha256, "closure_digest_invalid");
  equal(
    value.closureSha256,
    await sha256Canonical(without(value, "closureSha256")),
    "closure_digest_mismatch",
  );
  const rebuilt = await buildJsonCompatibilityExternalWormS3Closure({
    archiveEvidence,
    target: identityInput(identity),
    writerObservations: value.rawWriterObservations,
    readbackObservations: value.rawReadbackObservations,
  });
  canonicalEqual(rebuilt, value, "closure_binding_mismatch");
  return cloneJson(value);
}

async function buildObjectBinding({
  identity,
  descriptor,
  writer,
  reader,
  c2Write,
  c2Readback,
}) {
  if (!descriptor || !writer || !reader || !c2Write || !c2Readback) {
    fail("object_binding_member_missing");
  }
  canonicalEqual(writer.target, reader.target, "writer_reader_target_mismatch");
  const requestedProperties = [
    "contentLength", "contentSha256", "checksumSha256Base64", "contentType",
    "metadata", "metadataSha256", "objectLockMode", "retainUntil",
  ];
  for (const property of requestedProperties) {
    canonicalEqual(
      writer.requested[property],
      reader.requested[property],
      "writer_reader_object_request_mismatch",
    );
  }
  equal(
    writer.providerResponse.versionId,
    reader.requested.versionId,
    "writer_reader_version_mismatch",
  );
  equal(
    writer.providerResponse.versionIdSha256,
    reader.requested.versionIdSha256,
    "writer_reader_version_digest_mismatch",
  );
  equal(writer.providerResponse.eTag, reader.requested.eTag, "writer_reader_etag_mismatch");
  equal(
    writer.providerResponse.eTagSha256,
    reader.requested.eTagSha256,
    "writer_reader_etag_digest_mismatch",
  );
  const writerRetainUntilEpochSeconds = epochSeconds(
    writer.requested.retainUntil,
  );
  const readbackRetainUntilEpochSeconds = epochSeconds(
    reader.providerReadback.retention.retainUntil,
  );
  const writerObservedAtEpochSeconds = epochSeconds(writer.observedAt, true);
  const readbackObservedAtEpochSeconds = epochSeconds(reader.observedAt, true);
  const readerProviderRequestSetSha256 = await readbackRequestSetSha256(reader);
  for (const observation of [c2Write, c2Readback]) {
    equal(
      observation.objectDescriptorSha256,
      descriptor.objectDescriptorSha256,
      "c2_descriptor_binding_mismatch",
    );
    equal(observation.objectKeySha256, writer.target.objectKeySha256, "c2_key_binding_mismatch");
    equal(
      observation.objectVersionSha256,
      writer.providerResponse.versionIdSha256,
      "c2_version_binding_mismatch",
    );
    equal(
      observation.objectEtagSha256,
      writer.providerResponse.eTagSha256,
      "c2_etag_binding_mismatch",
    );
    equal(observation.bodySha256, writer.requested.contentSha256, "c2_body_binding_mismatch");
    equal(observation.byteLength, writer.requested.contentLength, "c2_length_binding_mismatch");
  }
  equal(c2Write.retainUntil, writerRetainUntilEpochSeconds, "c2_writer_retention_mismatch");
  equal(c2Readback.retainUntil, readbackRetainUntilEpochSeconds, "c2_readback_retention_mismatch");
  equal(c2Write.observedAt, writerObservedAtEpochSeconds, "c2_writer_time_mismatch");
  equal(c2Readback.observedAt, readbackObservedAtEpochSeconds, "c2_readback_time_mismatch");
  equal(
    c2Write.providerRequestIdSha256,
    writer.providerResponse.providerRequestIdSha256,
    "c2_writer_request_id_mismatch",
  );
  equal(
    c2Readback.providerRequestIdSha256,
    readerProviderRequestSetSha256,
    "c2_readback_request_set_mismatch",
  );
  const subject = {
    schemaVersion: 1,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBJECT_BINDING_CONTRACT,
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: identity.region,
    bucketNameSha256: identity.bucketNameSha256,
    expectedBucketOwnerSha256: identity.expectedBucketOwnerSha256,
    objectDescriptorSha256: descriptor.objectDescriptorSha256,
    objectKeySha256: writer.target.objectKeySha256,
    writerProviderObservationSha256: await sha256Canonical(writer),
    readerProviderObservationSha256: await sha256Canonical(reader),
    c2WriteObjectObservationSha256: c2Write.objectObservationSha256,
    c2ReadbackObjectObservationSha256: c2Readback.objectObservationSha256,
    versionId: writer.providerResponse.versionId,
    versionIdSha256: writer.providerResponse.versionIdSha256,
    eTag: writer.providerResponse.eTag,
    eTagSha256: writer.providerResponse.eTagSha256,
    checksumSha256Base64: writer.requested.checksumSha256Base64,
    bodySha256: writer.requested.contentSha256,
    byteLength: writer.requested.contentLength,
    contentType: writer.requested.contentType,
    metadataSha256: writer.requested.metadataSha256,
    writerRetainUntil: writer.requested.retainUntil,
    writerRetainUntilEpochSeconds,
    readbackRetainUntil: reader.providerReadback.retention.retainUntil,
    readbackRetainUntilEpochSeconds,
    writerObservedAt: writer.observedAt,
    writerObservedAtEpochSeconds,
    readbackObservedAt: reader.observedAt,
    readbackObservedAtEpochSeconds,
    writerProviderRequestIdSha256:
      writer.providerResponse.providerRequestIdSha256,
    readerBucketVersioningRequestIdSha256:
      reader.providerReadback.bucket.versioningRequestIdSha256,
    readerBucketObjectLockRequestIdSha256:
      reader.providerReadback.bucket.objectLockRequestIdSha256,
    readerObjectRequestIdSha256:
      reader.providerReadback.object.providerRequestIdSha256,
    readerRetentionRequestIdSha256:
      reader.providerReadback.retention.providerRequestIdSha256,
    readerProviderRequestSetSha256,
    writerCredentialIdSha256: writer.credential.credentialIdSha256,
    readerCredentialIdSha256: reader.credential.credentialIdSha256,
    readerWriterCredentialIdSha256: reader.writerCredentialIdSha256,
  };
  return {
    ...subject,
    objectBindingSha256: await sha256Canonical(subject),
  };
}

async function verifyC2Evidence(input) {
  const evidence = record(input, "c2_evidence_invalid");
  exactKeys(evidence, [
    "schemaVersion", "contract", "kind", "environment", "archivePolicy",
    "archiveManifest", "writeObservationEnvelope",
    "independentReadbackEnvelope", "archivePolicySha256",
    "archiveManifestSha256", "writeObservationEnvelopeSha256",
    "independentReadbackEnvelopeSha256", "accountBindingEvidenceSha256",
    "accountBindingInventorySha256", "objectIdentitySetSha256",
    "exactObjectReadback", "independentWriterAndReader",
    "complianceRetentionVerified", "observedAt", "archiveEvidenceSha256",
  ], "c2_evidence_keys_invalid");
  equal(evidence.schemaVersion, 1, "c2_evidence_schema_invalid");
  equal(evidence.contract, C2_EVIDENCE_CONTRACT, "c2_evidence_contract_invalid");
  equal(
    evidence.kind,
    "container-runtime-json-compatibility-external-worm-archive-evidence",
    "c2_evidence_kind_invalid",
  );
  equal(evidence.environment, "staging", "c2_evidence_environment_invalid");
  for (const property of [
    "exactObjectReadback", "independentWriterAndReader",
    "complianceRetentionVerified",
  ]) equal(evidence[property], true, "c2_evidence_classification_invalid");
  const policy = await validateC2Policy(evidence.archivePolicy);
  const manifest = await validateC2Manifest(policy, evidence.archiveManifest);
  const writeEnvelope = await validateC2Envelope(
    evidence.writeObservationEnvelope,
    "writer",
    policy.writer,
    policy,
    manifest,
    null,
  );
  const readbackEnvelope = await validateC2Envelope(
    evidence.independentReadbackEnvelope,
    "independent-readback",
    policy.readback,
    policy,
    manifest,
    writeEnvelope,
  );
  equal(evidence.archivePolicySha256, policy.archivePolicySha256, "c2_policy_digest_mismatch");
  equal(evidence.archiveManifestSha256, manifest.archiveManifestSha256, "c2_manifest_digest_mismatch");
  equal(
    evidence.writeObservationEnvelopeSha256,
    writeEnvelope.attestationEnvelopeSha256,
    "c2_writer_envelope_digest_mismatch",
  );
  equal(
    evidence.independentReadbackEnvelopeSha256,
    readbackEnvelope.attestationEnvelopeSha256,
    "c2_readback_envelope_digest_mismatch",
  );
  equal(
    evidence.accountBindingEvidenceSha256,
    manifest.accountBindingEvidenceSha256,
    "c2_account_binding_evidence_mismatch",
  );
  equal(
    evidence.accountBindingInventorySha256,
    manifest.accountBindingInventorySha256,
    "c2_account_binding_inventory_mismatch",
  );
  equal(
    evidence.objectIdentitySetSha256,
    writeEnvelope.subject.objectIdentitySetSha256,
    "c2_object_identity_set_mismatch",
  );
  equal(
    writeEnvelope.subject.objectIdentitySetSha256,
    readbackEnvelope.subject.objectIdentitySetSha256,
    "c2_readback_identity_set_mismatch",
  );
  equal(evidence.observedAt, readbackEnvelope.subject.completedAt, "c2_observed_time_mismatch");
  await documentDigest(evidence, "archiveEvidenceSha256", "c2_evidence_digest_mismatch");
  return {
    evidence: cloneJson(evidence),
    policy,
    manifest,
    writeSubject: writeEnvelope.subject,
    readbackSubject: readbackEnvelope.subject,
  };
}

async function validateC2Policy(input) {
  const value = record(input, "c2_policy_invalid");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "archiveBackend",
    "providerControl", "r2BucketLockAccepted", "backendIdentitySha256",
    "namespaceIdentitySha256", "retentionMode", "legalHoldRequired",
    "minimumRetentionSeconds", "minimumReadbackDelaySeconds",
    "maximumReadbackDelaySeconds", "effectiveAt", "writer", "readback",
    "independentPrincipalsRequired", "independentCredentialsRequired",
    "independentKeysRequired", "writerDeleteForbidden",
    "writerRetentionReductionForbidden", "readbackReadOnlyRequired",
    "readbackWriteForbidden", "readbackDeleteForbidden",
    "readbackRetentionMutationForbidden", "archivePolicySha256",
  ], "c2_policy_keys_invalid");
  equal(value.schemaVersion, 1, "c2_policy_schema_invalid");
  equal(value.contract, C2_POLICY_CONTRACT, "c2_policy_contract_invalid");
  equal(value.environment, "staging", "c2_policy_environment_invalid");
  equal(value.archiveBackend, "external-worm", "c2_policy_backend_invalid");
  equal(
    value.providerControl,
    "version-specific-object-lock-compliance",
    "c2_policy_provider_control_invalid",
  );
  equal(value.r2BucketLockAccepted, false, "c2_policy_r2_invalid");
  equal(value.retentionMode, "compliance", "c2_policy_retention_mode_invalid");
  equal(value.legalHoldRequired, false, "c2_policy_legal_hold_invalid");
  sha256(value.backendIdentitySha256, "c2_policy_backend_identity_invalid");
  sha256(value.namespaceIdentitySha256, "c2_policy_namespace_identity_invalid");
  integer(value.minimumRetentionSeconds, "c2_policy_retention_invalid");
  integer(value.minimumReadbackDelaySeconds, "c2_policy_delay_invalid");
  integer(value.maximumReadbackDelaySeconds, "c2_policy_delay_invalid");
  integer(value.effectiveAt, "c2_policy_time_invalid");
  const writer = await validateC2Actor(value.writer, "writer");
  const readback = await validateC2Actor(value.readback, "readback");
  for (const property of [
    "principalIdentitySha256", "credentialIdSha256", "spkiSha256",
    "permissionSetSha256", "keyId",
  ]) {
    if (writer[property] === readback[property]) fail("c2_policy_actor_reuse");
  }
  for (const property of [
    "independentPrincipalsRequired", "independentCredentialsRequired",
    "independentKeysRequired", "writerDeleteForbidden",
    "writerRetentionReductionForbidden", "readbackReadOnlyRequired",
    "readbackWriteForbidden", "readbackDeleteForbidden",
    "readbackRetentionMutationForbidden",
  ]) equal(value[property], true, "c2_policy_control_invalid");
  await documentDigest(value, "archivePolicySha256", "c2_policy_digest_mismatch");
  return cloneJson({ ...value, writer, readback });
}

async function validateC2Actor(input, label) {
  const value = record(input, `c2_${label}_actor_invalid`);
  exactKeys(value, [
    "keyId", "spkiSha256", "spkiBase64url", "principalIdentitySha256",
    "credentialIdSha256", "permissionSetSha256",
  ], `c2_${label}_actor_keys_invalid`);
  safeToken(value.keyId, `c2_${label}_key_id_invalid`);
  const spki = decodeBase64url(value.spkiBase64url, `c2_${label}_spki_invalid`);
  equal(
    value.spkiSha256,
    await sha256Bytes(spki),
    `c2_${label}_spki_digest_mismatch`,
  );
  for (const property of [
    "spkiSha256", "principalIdentitySha256", "credentialIdSha256",
    "permissionSetSha256",
  ]) sha256(value[property], `c2_${label}_actor_digest_invalid`);
  return cloneJson(value);
}

async function validateC2Manifest(policy, input) {
  const value = record(input, "c2_manifest_invalid");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment",
    "archiveOperationIdSha256", "archivePolicySha256", "accountIdSha256",
    "campaignPlanDigestSha256", "statePlanDigestSha256",
    "collectionProfileSha256", "collectorIdentitySha256", "collection",
    "independentReadback", "accountBindingEvidenceSha256",
    "accountBindingInventorySha256", "transitionSourceManifestSha256",
    "phaseSourceManifestSha256", "artifactInventoryReadbackSha256",
    "objects", "archiveObjectSetSha256", "archiveObjectCount",
    "archiveTotalByteLength", "createdAt", "archiveManifestSha256",
  ], "c2_manifest_keys_invalid");
  equal(value.schemaVersion, 1, "c2_manifest_schema_invalid");
  equal(value.contract, C2_MANIFEST_CONTRACT, "c2_manifest_contract_invalid");
  equal(
    value.kind,
    "container-runtime-json-compatibility-external-worm-archive-manifest",
    "c2_manifest_kind_invalid",
  );
  equal(value.environment, "staging", "c2_manifest_environment_invalid");
  equal(value.archivePolicySha256, policy.archivePolicySha256, "c2_manifest_policy_mismatch");
  for (const property of [
    "archiveOperationIdSha256", "accountIdSha256", "campaignPlanDigestSha256",
    "statePlanDigestSha256", "collectionProfileSha256",
    "collectorIdentitySha256", "accountBindingEvidenceSha256",
    "accountBindingInventorySha256", "transitionSourceManifestSha256",
    "artifactInventoryReadbackSha256",
  ]) sha256(value[property], "c2_manifest_digest_invalid");
  if (value.phaseSourceManifestSha256 !== null) {
    sha256(value.phaseSourceManifestSha256, "c2_phase_manifest_digest_invalid");
  }
  const collection = await validateC2PassRoot(value.collection, "collection");
  const independentReadback = await validateC2PassRoot(
    value.independentReadback,
    "independent-readback",
  );
  const objects = await validateC2DescriptorSet(value.objects);
  equal(value.archiveObjectCount, objects.length, "c2_manifest_object_count_mismatch");
  equal(
    value.archiveTotalByteLength,
    objects.reduce((sum, object) => sum + object.byteLength, 0),
    "c2_manifest_byte_length_mismatch",
  );
  equal(
    value.archiveObjectSetSha256,
    await sha256Canonical(objects),
    "c2_manifest_object_set_digest_mismatch",
  );
  integer(value.createdAt, "c2_manifest_time_invalid");
  await documentDigest(value, "archiveManifestSha256", "c2_manifest_digest_mismatch");
  return cloneJson({ ...value, collection, independentReadback, objects });
}

async function validateC2PassRoot(input, mode) {
  const value = record(input, "c2_pass_root_invalid");
  exactKeys(value, [
    "schemaVersion", "contract", "mode", "credentialReceiptSha256",
    "custodianIdentitySha256", "authenticationIdentitySha256",
    "collectionArtifactSha256", "snapshotSha256", "pageChainHeadSha256",
    "captureManifestSha256", "captureTerminalSha256", "pageCount",
    "passObjectSetSha256", "passObjectCount", "passTotalByteLength",
    "rawResponseByteLength", "observedAt", "passRootSha256",
  ], "c2_pass_root_keys_invalid");
  equal(value.schemaVersion, 1, "c2_pass_root_schema_invalid");
  equal(value.contract, C2_PASS_ROOT_CONTRACT, "c2_pass_root_contract_invalid");
  equal(value.mode, mode, "c2_pass_root_mode_invalid");
  for (const property of [
    "credentialReceiptSha256", "custodianIdentitySha256",
    "authenticationIdentitySha256", "collectionArtifactSha256",
    "snapshotSha256", "pageChainHeadSha256", "captureManifestSha256",
    "captureTerminalSha256", "passObjectSetSha256",
  ]) sha256(value[property], "c2_pass_root_digest_invalid");
  for (const property of [
    "pageCount", "passObjectCount", "passTotalByteLength",
    "rawResponseByteLength", "observedAt",
  ]) integer(value[property], "c2_pass_root_integer_invalid");
  await documentDigest(value, "passRootSha256", "c2_pass_root_digest_mismatch");
  return cloneJson(value);
}

async function validateC2DescriptorSet(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_OBJECT_COUNT) {
    fail("c2_descriptor_set_invalid");
  }
  const values = [];
  for (const inputValue of input) {
    const value = record(inputValue, "c2_descriptor_invalid");
    exactKeys(value, [
      "schemaVersion", "contract", "logicalRole", "mode", "sequence",
      "resourceFamily", "objectKeySha256", "mediaType",
      "contentIdentitySha256", "bodySha256", "byteLength",
      "pageReceiptSha256", "objectDescriptorSha256",
    ], "c2_descriptor_keys_invalid");
    equal(value.schemaVersion, 1, "c2_descriptor_schema_invalid");
    equal(value.contract, C2_DESCRIPTOR_CONTRACT, "c2_descriptor_contract_invalid");
    equal(value.mediaType, "application/json", "c2_descriptor_media_type_invalid");
    for (const property of [
      "objectKeySha256", "contentIdentitySha256", "bodySha256",
    ]) sha256(value[property], "c2_descriptor_digest_invalid");
    if (value.pageReceiptSha256 !== null) {
      sha256(value.pageReceiptSha256, "c2_descriptor_page_receipt_invalid");
    }
    positiveInteger(value.byteLength, "c2_descriptor_byte_length_invalid");
    await documentDigest(
      value,
      "objectDescriptorSha256",
      "c2_descriptor_digest_mismatch",
    );
    values.push(cloneJson(value));
  }
  const sorted = [...values].sort(compareObjectKey);
  canonicalEqual(values, sorted, "c2_descriptor_order_invalid");
  rejectDuplicates(values.map((value) => value.objectKeySha256), "c2_descriptor_key_duplicate");
  rejectDuplicates(
    values.map((value) => value.objectDescriptorSha256),
    "c2_descriptor_digest_duplicate",
  );
  return values;
}

async function validateC2Envelope(
  input,
  role,
  actor,
  policy,
  manifest,
  writeEnvelope,
) {
  const value = record(input, "c2_envelope_invalid");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "role", "algorithm",
    "keyId", "signerSpkiBase64url", "signerSpkiSha256", "subject",
    "subjectSha256", "signatureBase64url", "attestationEnvelopeSha256",
  ], "c2_envelope_keys_invalid");
  equal(value.schemaVersion, 1, "c2_envelope_schema_invalid");
  equal(value.contract, C2_ATTESTATION_CONTRACT, "c2_envelope_contract_invalid");
  equal(value.environment, "staging", "c2_envelope_environment_invalid");
  equal(value.role, role, "c2_envelope_role_invalid");
  equal(value.algorithm, "Ed25519", "c2_envelope_algorithm_invalid");
  equal(value.keyId, actor.keyId, "c2_envelope_key_id_mismatch");
  equal(value.signerSpkiBase64url, actor.spkiBase64url, "c2_envelope_spki_mismatch");
  equal(value.signerSpkiSha256, actor.spkiSha256, "c2_envelope_spki_digest_mismatch");
  const subject = await validateC2Subject(
    value.subject,
    role,
    actor,
    policy,
    manifest,
    writeEnvelope,
  );
  const subjectDigest = role === "writer"
    ? subject.writeObservationSubjectSha256
    : subject.readbackObservationSubjectSha256;
  equal(value.subjectSha256, subjectDigest, "c2_envelope_subject_digest_mismatch");
  const signature = decodeBase64url(value.signatureBase64url, "c2_signature_invalid");
  if (signature.byteLength !== 64) fail("c2_signature_length_invalid");
  await documentDigest(
    value,
    "attestationEnvelopeSha256",
    "c2_envelope_digest_mismatch",
  );
  const spki = decodeBase64url(actor.spkiBase64url, "c2_signer_spki_invalid");
  let key;
  try {
    key = await globalThis.crypto.subtle.importKey(
      "spki",
      spki,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch {
    fail("c2_signer_spki_invalid");
  }
  const domain = role === "writer" ? C2_WRITER_DOMAIN : C2_READBACK_DOMAIN;
  const payload = new TextEncoder().encode(`${domain}${canonicalJson(subject)}`);
  let valid = false;
  try {
    valid = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      payload,
    );
  } catch {
    fail("c2_signature_verification_failed");
  }
  if (!valid) fail("c2_signature_invalid");
  return cloneJson({ ...value, subject });
}

async function validateC2Subject(
  input,
  role,
  actor,
  policy,
  manifest,
  writeEnvelope,
) {
  const value = record(input, "c2_subject_invalid");
  const commonKeys = [
    "schemaVersion", "contract", "environment", "attestationRole",
    "archiveOperationIdSha256", role === "writer"
      ? "writeOperationIdSha256"
      : "readbackOperationIdSha256",
    "archivePolicySha256", "archiveManifestSha256",
    ...(role === "writer" ? [] : ["writeObservationEnvelopeSha256"]),
    "accountBindingEvidenceSha256", "attestorKeyId", "attestorSpkiSha256",
    "principalIdentitySha256", "credentialIdSha256", "permissionSetSha256",
    "backendIdentitySha256", "namespaceIdentitySha256",
    "providerObservationSetSha256",
    ...(role === "writer" ? [] : [
      "readOnly", "writePermissionsAbsent", "deletePermissionsAbsent",
      "retentionMutationPermissionsAbsent",
    ]),
    "observations", "objectIdentitySetSha256", "objectObservationSetSha256",
    "objectCount", "totalByteLength", "retainUntil", "startedAt",
    ...(role === "writer" ? ["lockedAt"] : []), "completedAt",
    role === "writer"
      ? "writeObservationSubjectSha256"
      : "readbackObservationSubjectSha256",
  ];
  exactKeys(value, commonKeys, "c2_subject_keys_invalid");
  equal(value.schemaVersion, 1, "c2_subject_schema_invalid");
  equal(
    value.contract,
    role === "writer" ? C2_WRITE_SUBJECT_CONTRACT : C2_READBACK_SUBJECT_CONTRACT,
    "c2_subject_contract_invalid",
  );
  equal(value.environment, "staging", "c2_subject_environment_invalid");
  equal(value.attestationRole, role, "c2_subject_role_invalid");
  equal(value.archiveOperationIdSha256, manifest.archiveOperationIdSha256, "c2_subject_operation_mismatch");
  equal(value.archivePolicySha256, policy.archivePolicySha256, "c2_subject_policy_mismatch");
  equal(value.archiveManifestSha256, manifest.archiveManifestSha256, "c2_subject_manifest_mismatch");
  equal(
    value.accountBindingEvidenceSha256,
    manifest.accountBindingEvidenceSha256,
    "c2_subject_account_evidence_mismatch",
  );
  for (const [subjectProperty, actorProperty] of [
    ["attestorKeyId", "keyId"], ["attestorSpkiSha256", "spkiSha256"],
    ["principalIdentitySha256", "principalIdentitySha256"],
    ["credentialIdSha256", "credentialIdSha256"],
    ["permissionSetSha256", "permissionSetSha256"],
  ]) equal(value[subjectProperty], actor[actorProperty], "c2_subject_actor_mismatch");
  equal(value.backendIdentitySha256, policy.backendIdentitySha256, "c2_subject_backend_mismatch");
  equal(value.namespaceIdentitySha256, policy.namespaceIdentitySha256, "c2_subject_namespace_mismatch");
  sha256(
    value.providerObservationSetSha256,
    "c2_subject_provider_observation_set_invalid",
  );
  if (role !== "writer") {
    if (!writeEnvelope) fail("c2_readback_write_envelope_missing");
    equal(
      value.writeObservationEnvelopeSha256,
      writeEnvelope.attestationEnvelopeSha256,
      "c2_readback_write_envelope_mismatch",
    );
    for (const property of [
      "readOnly", "writePermissionsAbsent", "deletePermissionsAbsent",
      "retentionMutationPermissionsAbsent",
    ]) equal(value[property], true, "c2_readback_permission_classification_invalid");
  }
  const observations = await validateC2ObservationSet(
    value.observations,
    manifest.objects,
  );
  equal(value.objectCount, observations.length, "c2_subject_object_count_mismatch");
  equal(
    value.totalByteLength,
    observations.reduce((sum, observation) => sum + observation.byteLength, 0),
    "c2_subject_byte_length_mismatch",
  );
  equal(
    value.retainUntil,
    Math.min(...observations.map((observation) => observation.retainUntil)),
    "c2_subject_retention_mismatch",
  );
  equal(
    value.objectIdentitySetSha256,
    await sha256Canonical(observations.map(objectIdentity)),
    "c2_subject_identity_set_mismatch",
  );
  equal(
    value.objectObservationSetSha256,
    await sha256Canonical(observations),
    "c2_subject_observation_set_mismatch",
  );
  integer(value.startedAt, "c2_subject_time_invalid");
  integer(value.completedAt, "c2_subject_time_invalid");
  if (role === "writer") integer(value.lockedAt, "c2_subject_time_invalid");
  const digestProperty = role === "writer"
    ? "writeObservationSubjectSha256"
    : "readbackObservationSubjectSha256";
  await documentDigest(value, digestProperty, "c2_subject_digest_mismatch");
  if (writeEnvelope) {
    const writeMap = mapByKey(writeEnvelope.subject.observations);
    for (const observation of observations) {
      const written = writeMap.get(observation.objectKeySha256);
      if (!written
        || canonicalJson(objectIdentity(written)) !== canonicalJson(objectIdentity(observation))
        || observation.retainUntil < written.retainUntil
        || observation.providerRequestIdSha256 === written.providerRequestIdSha256) {
        fail("c2_readback_observation_mismatch");
      }
    }
  }
  return cloneJson({ ...value, observations });
}

async function validateC2ObservationSet(input, descriptors) {
  if (!Array.isArray(input) || input.length !== descriptors.length) {
    fail("c2_observation_set_invalid");
  }
  const descriptorMap = new Map(
    descriptors.map((value) => [value.objectDescriptorSha256, value]),
  );
  const values = [];
  for (const inputValue of input) {
    const value = record(inputValue, "c2_observation_invalid");
    exactKeys(value, [
      "schemaVersion", "contract", "objectDescriptorSha256",
      "objectKeySha256", "objectVersionSha256", "objectEtagSha256",
      "bodySha256", "byteLength", "retentionMode", "retainUntil",
      "providerRequestIdSha256", "observedAt", "objectObservationSha256",
    ], "c2_observation_keys_invalid");
    equal(value.schemaVersion, 1, "c2_observation_schema_invalid");
    equal(value.contract, C2_OBJECT_OBSERVATION_CONTRACT, "c2_observation_contract_invalid");
    const descriptor = descriptorMap.get(value.objectDescriptorSha256);
    if (!descriptor) fail("c2_observation_descriptor_unknown");
    equal(value.objectKeySha256, descriptor.objectKeySha256, "c2_observation_key_mismatch");
    equal(value.bodySha256, descriptor.bodySha256, "c2_observation_body_mismatch");
    equal(value.byteLength, descriptor.byteLength, "c2_observation_length_mismatch");
    for (const property of [
      "objectVersionSha256", "objectEtagSha256", "providerRequestIdSha256",
    ]) sha256(value[property], "c2_observation_digest_invalid");
    equal(value.retentionMode, "compliance", "c2_observation_retention_mode_invalid");
    integer(value.retainUntil, "c2_observation_retention_invalid");
    integer(value.observedAt, "c2_observation_time_invalid");
    await documentDigest(
      value,
      "objectObservationSha256",
      "c2_observation_digest_mismatch",
    );
    values.push(cloneJson(value));
  }
  const sorted = [...values].sort(compareObjectKey);
  canonicalEqual(values, sorted, "c2_observation_order_invalid");
  rejectDuplicates(values.map((value) => value.objectKeySha256), "c2_observation_key_duplicate");
  rejectDuplicates(
    values.map((value) => value.providerRequestIdSha256),
    "c2_observation_request_duplicate",
  );
  return values;
}

async function normalizeObservationSet(input, keys, validator, label) {
  if (!Array.isArray(input) || input.length !== keys.length) {
    fail(`${label}_observation_count_mismatch`);
  }
  const values = await Promise.all(input.map((value) => validator(value)));
  values.sort((left, right) => compareAscii(
    left.target.objectKeySha256,
    right.target.objectKeySha256,
  ));
  rejectDuplicates(
    values.map((value) => value.target.objectKeySha256),
    `${label}_object_key_duplicate`,
  );
  canonicalEqual(
    values.map((value) => value.target.objectKeySha256),
    keys,
    `${label}_object_key_set_mismatch`,
  );
  const digests = await Promise.all(values.map(sha256Canonical));
  rejectDuplicates(digests, `${label}_provider_observation_duplicate`);
  return values;
}

async function readbackRequestSetSha256(value) {
  return sha256Canonical({
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-external-worm-s3-readback-request-set-v1",
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

async function validateIdentity(input) {
  const value = record(input, "identity_invalid");
  exactKeys(value, IDENTITY_KEYS, "identity_keys_invalid");
  const rebuilt = await deriveJsonCompatibilityExternalWormS3ArchiveIdentities(
    identityInput(value),
  );
  canonicalEqual(rebuilt, value, "identity_binding_mismatch");
  return rebuilt;
}

async function validateBinding(input) {
  const value = record(input, "object_binding_invalid");
  exactKeys(value, BINDING_KEYS, "object_binding_keys_invalid");
  for (const property of [
    "bucketNameSha256", "expectedBucketOwnerSha256",
    "objectDescriptorSha256", "objectKeySha256",
    "writerProviderObservationSha256", "readerProviderObservationSha256",
    "c2WriteObjectObservationSha256", "c2ReadbackObjectObservationSha256",
    "versionIdSha256", "eTagSha256", "bodySha256", "metadataSha256",
    "writerProviderRequestIdSha256", "readerBucketVersioningRequestIdSha256",
    "readerBucketObjectLockRequestIdSha256", "readerObjectRequestIdSha256",
    "readerRetentionRequestIdSha256", "readerProviderRequestSetSha256",
    "writerCredentialIdSha256", "readerCredentialIdSha256",
    "readerWriterCredentialIdSha256", "objectBindingSha256",
  ]) sha256(value[property], "object_binding_digest_invalid");
  equal(
    value.objectBindingSha256,
    await sha256Canonical(without(value, "objectBindingSha256")),
    "object_binding_digest_mismatch",
  );
  return cloneJson(value);
}

function assertUniformTarget(values, identity) {
  for (const value of values) {
    equal(value.provider, identity.provider, "provider_target_mismatch");
    equal(value.target.region, identity.region, "region_target_mismatch");
    equal(value.target.bucketNameSha256, identity.bucketNameSha256, "bucket_target_mismatch");
    equal(
      value.target.expectedBucketOwnerSha256,
      identity.expectedBucketOwnerSha256,
      "owner_target_mismatch",
    );
  }
}

function rejectAllProviderRequestIdReuse(bindings) {
  const values = [];
  for (const binding of bindings) {
    values.push(
      binding.writerProviderRequestIdSha256,
      binding.readerBucketVersioningRequestIdSha256,
      binding.readerBucketObjectLockRequestIdSha256,
      binding.readerObjectRequestIdSha256,
      binding.readerRetentionRequestIdSha256,
    );
  }
  rejectDuplicates(values, "provider_request_id_reuse");
}

async function documentDigest(value, property, code) {
  sha256(value[property], code);
  equal(value[property], await sha256Canonical(without(value, property)), code);
}

function identityInput(value) {
  return {
    provider: value.provider,
    region: value.region,
    bucketNameSha256: value.bucketNameSha256,
    expectedBucketOwnerSha256: value.expectedBucketOwnerSha256,
    objectKeySha256s: value.objectKeySha256s,
  };
}

function objectIdentity(value) {
  return {
    objectKeySha256: value.objectKeySha256,
    objectVersionSha256: value.objectVersionSha256,
    objectEtagSha256: value.objectEtagSha256,
    bodySha256: value.bodySha256,
    byteLength: value.byteLength,
  };
}

function mapByKey(values) {
  return new Map(values.map((value) => [
    value.objectKeySha256 ?? value.target.objectKeySha256,
    value,
  ]));
}

function oneCredential(values, code) {
  const credentials = new Set(
    values.map((value) => value.credential.credentialIdSha256),
  );
  if (credentials.size !== 1) fail(code);
  return [...credentials][0];
}

function epochSeconds(value, floor = false) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("timestamp_invalid");
  if (!floor && milliseconds % 1_000 !== 0) fail("timestamp_precision_invalid");
  return floor ? Math.floor(milliseconds / 1_000) : milliseconds / 1_000;
}

function normalizeDigestSet(input, code) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_OBJECT_COUNT) {
    fail(code);
  }
  const values = input.map((value) => sha256(value, code)).sort(compareAscii);
  rejectDuplicates(values, code);
  return values;
}

function decodeBase64url(value, code) {
  if (typeof value !== "string" || value.length < 1 || !BASE64URL.test(value)) {
    fail(code);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = globalThis.atob(padded);
  } catch {
    fail(code);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64url(bytes) !== value) fail(code);
  return bytes;
}

function encodeBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function safeToken(value, code) {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(code);
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

function canonicalEqual(actual, expected, code) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(code);
}

function equal(actual, expected, code) {
  if (actual !== expected) fail(code);
}

function sha256(value, code) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function integer(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
}

function rejectDuplicates(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function compareObjectKey(left, right) {
  return compareAscii(left.objectKeySha256, right.objectKeySha256);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function without(value, property) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== property),
  );
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function fail(code) {
  throw new JsonCompatibilityExternalWormS3ClosureError(code);
}
