import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { Buffer } from "node:buffer";

import {
  canonicalJson,
  sha256Canonical,
} from "./container_runtime_json_compatibility_campaign.mjs";

export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-policy-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_PASS_ROOT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-pass-root-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_DESCRIPTOR_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-descriptor-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_MANIFEST_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-manifest-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_OBSERVATION_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-object-observation-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_WRITE_OBSERVATION_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-write-observation-subject-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_OBSERVATION_SUBJECT_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-readback-observation-subject-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ATTESTATION_ENVELOPE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-attestation-envelope-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_EVIDENCE_CONTRACT =
  "cinatoken-container-runtime-json-compatibility-external-worm-archive-evidence-v1";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_WRITER_ATTESTATION_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-external-worm-writer-attestation-v1\n";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN =
  "cinatoken-container-runtime-json-compatibility-external-worm-independent-readback-attestation-v1\n";
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS =
  365 * 24 * 60 * 60;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_READBACK_DELAY_SECONDS = 5;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_READBACK_DELAY_SECONDS = 900;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_OBJECT_COUNT = 512;
export const JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_TOTAL_BYTES =
  768 * 1024 * 1024;

export const JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_ROLES =
  Object.freeze([
    "account-binding-evidence",
    "account-binding-inventory",
    "artifact-inventory-readback",
    "campaign-plan",
    "capture-manifest",
    "capture-terminal",
    "collection-artifact",
    "collection-profile",
    "collector-identity",
    "page-receipt",
    "phase-source-manifest",
    "raw-response-body",
    "state-plan",
    "transition-source-manifest",
  ]);

const SCHEMA_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROLE_SET = new Set(JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_ROLES);
const PASS_ROLES = new Set([
  "capture-manifest",
  "capture-terminal",
  "collection-artifact",
  "page-receipt",
  "raw-response-body",
]);
const PAGE_ROLES = new Set(["page-receipt", "raw-response-body"]);
const GLOBAL_ROLE_BINDINGS = Object.freeze([
  ["campaign-plan", "campaignPlanDigestSha256"],
  ["state-plan", "statePlanDigestSha256"],
  ["collector-identity", "collectorIdentitySha256"],
  ["collection-profile", "collectionProfileSha256"],
  ["account-binding-evidence", "accountBindingEvidenceSha256"],
  ["account-binding-inventory", "accountBindingInventorySha256"],
  ["transition-source-manifest", "transitionSourceManifestSha256"],
  ["artifact-inventory-readback", "artifactInventoryReadbackSha256"],
]);

export class JsonCompatibilityExternalWormArchiveError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "JsonCompatibilityExternalWormArchiveError";
    this.code = code;
  }
}

export function buildJsonCompatibilityExternalWormArchivePolicy({
  backendIdentitySha256,
  namespaceIdentitySha256,
  effectiveAt,
  writer: writerInput,
  readback: readbackInput,
}) {
  sha256(backendIdentitySha256, "archive backend identity");
  sha256(namespaceIdentitySha256, "archive namespace identity");
  integer(effectiveAt, "archive policy effective time");
  const writer = normalizeTrustActor(writerInput, "writer");
  const readback = normalizeTrustActor(readbackInput, "readback");
  assertActorSeparation(writer, readback);
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_POLICY_CONTRACT,
    environment: "staging",
    archiveBackend: "external-worm",
    providerControl: "version-specific-object-lock-compliance",
    r2BucketLockAccepted: false,
    backendIdentitySha256,
    namespaceIdentitySha256,
    retentionMode: "compliance",
    legalHoldRequired: false,
    minimumRetentionSeconds:
      JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS,
    minimumReadbackDelaySeconds:
      JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_READBACK_DELAY_SECONDS,
    maximumReadbackDelaySeconds:
      JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_READBACK_DELAY_SECONDS,
    effectiveAt,
    writer,
    readback,
    independentPrincipalsRequired: true,
    independentCredentialsRequired: true,
    independentKeysRequired: true,
    writerDeleteForbidden: true,
    writerRetentionReductionForbidden: true,
    readbackReadOnlyRequired: true,
    readbackWriteForbidden: true,
    readbackDeleteForbidden: true,
    readbackRetentionMutationForbidden: true,
  };
  return {
    ...subject,
    archivePolicySha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormArchivePolicy(input) {
  const value = record(input, "archive policy");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "archiveBackend",
    "providerControl", "r2BucketLockAccepted",
    "backendIdentitySha256", "namespaceIdentitySha256", "retentionMode",
    "legalHoldRequired",
    "minimumRetentionSeconds", "minimumReadbackDelaySeconds",
    "maximumReadbackDelaySeconds", "effectiveAt", "writer", "readback",
    "independentPrincipalsRequired", "independentCredentialsRequired",
    "independentKeysRequired", "writerDeleteForbidden",
    "writerRetentionReductionForbidden", "readbackReadOnlyRequired",
    "readbackWriteForbidden", "readbackDeleteForbidden",
    "readbackRetentionMutationForbidden", "archivePolicySha256",
  ], "archive policy");
  const rebuilt = buildJsonCompatibilityExternalWormArchivePolicy({
    backendIdentitySha256: value.backendIdentitySha256,
    namespaceIdentitySha256: value.namespaceIdentitySha256,
    effectiveAt: value.effectiveAt,
    writer: value.writer,
    readback: value.readback,
  });
  canonicalEqual(rebuilt, value, "archive policy");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
  logicalRole,
  mode,
  sequence,
  resourceFamily,
  objectKeySha256,
  contentIdentitySha256,
  bodySha256,
  byteLength,
  pageReceiptSha256,
}) {
  if (!ROLE_SET.has(logicalRole)) fail("external_worm_object_role_invalid");
  nullableMode(mode);
  nullablePositiveInteger(sequence, "archive object sequence");
  nullableSafeToken(resourceFamily, "archive object resource family");
  sha256(objectKeySha256, "archive object key");
  sha256(contentIdentitySha256, "archive object content identity");
  sha256(bodySha256, "archive object body");
  positiveInteger(byteLength, "archive object byte length");
  if (byteLength > JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_TOTAL_BYTES) {
    fail("external_worm_archive_total_bytes_limit_exceeded");
  }
  nullableSha256(pageReceiptSha256, "archive object page receipt");
  if (PASS_ROLES.has(logicalRole)) {
    if (mode === null) fail("external_worm_object_mode_invalid");
  } else if (mode !== null) {
    fail("external_worm_object_mode_invalid");
  }
  if (PAGE_ROLES.has(logicalRole)) {
    if (
      sequence === null
      || resourceFamily === null
      || pageReceiptSha256 === null
    ) fail("external_worm_page_object_identity_invalid");
  } else if (
    sequence !== null
    || resourceFamily !== null
    || pageReceiptSha256 !== null
  ) {
    fail("external_worm_non_page_object_identity_invalid");
  }
  if (
    logicalRole === "raw-response-body"
    && contentIdentitySha256 !== bodySha256
  ) fail("external_worm_raw_body_identity_mismatch");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_DESCRIPTOR_CONTRACT,
    logicalRole,
    mode,
    sequence,
    resourceFamily,
    objectKeySha256,
    mediaType: "application/json",
    contentIdentitySha256,
    bodySha256,
    byteLength,
    pageReceiptSha256,
  };
  return {
    ...subject,
    objectDescriptorSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormArchiveObjectDescriptor(
  input,
) {
  const value = record(input, "archive object descriptor");
  exactKeys(value, [
    "schemaVersion", "contract", "logicalRole", "mode", "sequence",
    "resourceFamily", "objectKeySha256", "mediaType",
    "contentIdentitySha256", "bodySha256", "byteLength",
    "pageReceiptSha256", "objectDescriptorSha256",
  ], "archive object descriptor");
  equal(value.mediaType, "application/json", "archive object media type");
  const rebuilt = buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
    logicalRole: value.logicalRole,
    mode: value.mode,
    sequence: value.sequence,
    resourceFamily: value.resourceFamily,
    objectKeySha256: value.objectKeySha256,
    contentIdentitySha256: value.contentIdentitySha256,
    bodySha256: value.bodySha256,
    byteLength: value.byteLength,
    pageReceiptSha256: value.pageReceiptSha256,
  });
  canonicalEqual(rebuilt, value, "archive object descriptor");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormArchivePassRoot({
  mode,
  credentialReceiptSha256,
  custodianIdentitySha256,
  authenticationIdentitySha256,
  collectionArtifactSha256,
  snapshotSha256,
  pageChainHeadSha256,
  captureManifestSha256,
  captureTerminalSha256,
  objects: objectsInput,
  observedAt,
}) {
  collectionMode(mode);
  for (const [label, value] of [
    ["credential receipt", credentialReceiptSha256],
    ["custodian identity", custodianIdentitySha256],
    ["authentication identity", authenticationIdentitySha256],
    ["collection artifact", collectionArtifactSha256],
    ["snapshot", snapshotSha256],
    ["page chain head", pageChainHeadSha256],
    ["capture manifest", captureManifestSha256],
    ["capture terminal", captureTerminalSha256],
  ]) sha256(value, `archive pass ${label}`);
  integer(observedAt, "archive pass observation time");
  const objects = normalizeDescriptorSet(objectsInput)
    .filter((value) => value.mode === mode);
  const closure = assertPassObjectClosure(objects, mode, {
    collectionArtifactSha256,
    captureManifestSha256,
    captureTerminalSha256,
  });
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_PASS_ROOT_CONTRACT,
    mode,
    credentialReceiptSha256,
    custodianIdentitySha256,
    authenticationIdentitySha256,
    collectionArtifactSha256,
    snapshotSha256,
    pageChainHeadSha256,
    captureManifestSha256,
    captureTerminalSha256,
    pageCount: closure.pageCount,
    passObjectSetSha256: sha256Canonical(objects),
    passObjectCount: objects.length,
    passTotalByteLength: sumBytes(objects),
    rawResponseByteLength: closure.rawResponseByteLength,
    observedAt,
  };
  return {
    ...subject,
    passRootSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormArchivePassRoot(
  input,
  objects,
) {
  const value = record(input, "archive pass root");
  exactKeys(value, [
    "schemaVersion", "contract", "mode", "credentialReceiptSha256",
    "custodianIdentitySha256", "authenticationIdentitySha256",
    "collectionArtifactSha256", "snapshotSha256", "pageChainHeadSha256",
    "captureManifestSha256", "captureTerminalSha256", "pageCount",
    "passObjectSetSha256",
    "passObjectCount", "passTotalByteLength", "rawResponseByteLength",
    "observedAt", "passRootSha256",
  ], "archive pass root");
  const rebuilt = buildJsonCompatibilityExternalWormArchivePassRoot({
    mode: value.mode,
    credentialReceiptSha256: value.credentialReceiptSha256,
    custodianIdentitySha256: value.custodianIdentitySha256,
    authenticationIdentitySha256: value.authenticationIdentitySha256,
    collectionArtifactSha256: value.collectionArtifactSha256,
    snapshotSha256: value.snapshotSha256,
    pageChainHeadSha256: value.pageChainHeadSha256,
    captureManifestSha256: value.captureManifestSha256,
    captureTerminalSha256: value.captureTerminalSha256,
    objects,
    observedAt: value.observedAt,
  });
  canonicalEqual(rebuilt, value, "archive pass root");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormArchiveManifest({
  archivePolicy: policyInput,
  archiveOperationIdSha256,
  accountIdSha256,
  campaignPlanDigestSha256,
  statePlanDigestSha256,
  collectionProfileSha256,
  collectorIdentitySha256,
  collection: collectionInput,
  independentReadback: readbackInput,
  accountBindingEvidenceSha256,
  accountBindingInventorySha256,
  transitionSourceManifestSha256,
  phaseSourceManifestSha256,
  artifactInventoryReadbackSha256,
  objects: objectsInput,
  createdAt,
}) {
  const policy = validateJsonCompatibilityExternalWormArchivePolicy(policyInput);
  for (const [label, value] of [
    ["archive operation", archiveOperationIdSha256],
    ["account ID", accountIdSha256],
    ["campaign plan", campaignPlanDigestSha256],
    ["state plan", statePlanDigestSha256],
    ["collection profile", collectionProfileSha256],
    ["collector identity", collectorIdentitySha256],
    ["account binding evidence", accountBindingEvidenceSha256],
    ["account binding inventory", accountBindingInventorySha256],
    ["transition source manifest", transitionSourceManifestSha256],
    ["artifact inventory readback", artifactInventoryReadbackSha256],
  ]) sha256(value, `archive manifest ${label}`);
  nullableSha256(
    phaseSourceManifestSha256,
    "archive manifest phase source manifest",
  );
  integer(createdAt, "archive manifest creation time");
  const objects = normalizeDescriptorSet(objectsInput);
  const archiveTotalByteLength = sumArchiveBytes(objects);
  const collection = validateJsonCompatibilityExternalWormArchivePassRoot(
    collectionInput,
    objects,
  );
  const independentReadback =
    validateJsonCompatibilityExternalWormArchivePassRoot(
      readbackInput,
      objects,
    );
  equal(collection.mode, "collection", "archive collection pass mode");
  equal(
    independentReadback.mode,
    "independent-readback",
    "archive readback pass mode",
  );
  assertPassSeparation(collection, independentReadback);
  if (
    createdAt < policy.effectiveAt
    || createdAt < collection.observedAt
    || createdAt < independentReadback.observedAt
  ) fail("external_worm_manifest_time_order_invalid");
  const bindings = {
    campaignPlanDigestSha256,
    statePlanDigestSha256,
    collectorIdentitySha256,
    collectionProfileSha256,
    accountBindingEvidenceSha256,
    accountBindingInventorySha256,
    transitionSourceManifestSha256,
    artifactInventoryReadbackSha256,
  };
  for (const [role, property] of GLOBAL_ROLE_BINDINGS) {
    assertGlobalObject(objects, role, bindings[property]);
  }
  const phaseObjects = objects.filter(
    (value) => value.logicalRole === "phase-source-manifest",
  );
  if (phaseSourceManifestSha256 === null) {
    if (phaseObjects.length !== 0) fail("external_worm_global_object_set_invalid");
  } else {
    assertGlobalObject(
      objects,
      "phase-source-manifest",
      phaseSourceManifestSha256,
    );
  }
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_MANIFEST_CONTRACT,
    kind: "container-runtime-json-compatibility-external-worm-archive-manifest",
    environment: "staging",
    archiveOperationIdSha256,
    archivePolicySha256: policy.archivePolicySha256,
    accountIdSha256,
    campaignPlanDigestSha256,
    statePlanDigestSha256,
    collectionProfileSha256,
    collectorIdentitySha256,
    collection,
    independentReadback,
    accountBindingEvidenceSha256,
    accountBindingInventorySha256,
    transitionSourceManifestSha256,
    phaseSourceManifestSha256,
    artifactInventoryReadbackSha256,
    objects,
    archiveObjectSetSha256: sha256Canonical(objects),
    archiveObjectCount: objects.length,
    archiveTotalByteLength,
    createdAt,
  };
  return {
    ...subject,
    archiveManifestSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormArchiveManifest(
  archivePolicy,
  input,
) {
  const value = record(input, "archive manifest");
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
  ], "archive manifest");
  const rebuilt = buildJsonCompatibilityExternalWormArchiveManifest({
    archivePolicy,
    archiveOperationIdSha256: value.archiveOperationIdSha256,
    accountIdSha256: value.accountIdSha256,
    campaignPlanDigestSha256: value.campaignPlanDigestSha256,
    statePlanDigestSha256: value.statePlanDigestSha256,
    collectionProfileSha256: value.collectionProfileSha256,
    collectorIdentitySha256: value.collectorIdentitySha256,
    collection: value.collection,
    independentReadback: value.independentReadback,
    accountBindingEvidenceSha256: value.accountBindingEvidenceSha256,
    accountBindingInventorySha256: value.accountBindingInventorySha256,
    transitionSourceManifestSha256: value.transitionSourceManifestSha256,
    phaseSourceManifestSha256: value.phaseSourceManifestSha256,
    artifactInventoryReadbackSha256:
      value.artifactInventoryReadbackSha256,
    objects: value.objects,
    createdAt: value.createdAt,
  });
  canonicalEqual(rebuilt, value, "archive manifest");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormArchiveObjectObservation({
  objectDescriptor: descriptorInput,
  objectVersionSha256,
  objectEtagSha256,
  retainUntil,
  providerRequestIdSha256,
  observedAt,
}) {
  const descriptor =
    validateJsonCompatibilityExternalWormArchiveObjectDescriptor(
      descriptorInput,
    );
  sha256(objectVersionSha256, "archive object version");
  sha256(objectEtagSha256, "archive object ETag");
  integer(retainUntil, "archive object retention time");
  sha256(providerRequestIdSha256, "archive provider request ID");
  integer(observedAt, "archive object observation time");
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_OBSERVATION_CONTRACT,
    objectDescriptorSha256: descriptor.objectDescriptorSha256,
    objectKeySha256: descriptor.objectKeySha256,
    objectVersionSha256,
    objectEtagSha256,
    bodySha256: descriptor.bodySha256,
    byteLength: descriptor.byteLength,
    retentionMode: "compliance",
    retainUntil,
    providerRequestIdSha256,
    observedAt,
  };
  return {
    ...subject,
    objectObservationSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormArchiveObjectObservation(
  objectDescriptor,
  input,
) {
  const value = record(input, "archive object observation");
  exactKeys(value, [
    "schemaVersion", "contract", "objectDescriptorSha256",
    "objectKeySha256", "objectVersionSha256", "objectEtagSha256",
    "bodySha256", "byteLength", "retentionMode", "retainUntil",
    "providerRequestIdSha256", "observedAt", "objectObservationSha256",
  ], "archive object observation");
  const rebuilt = buildJsonCompatibilityExternalWormArchiveObjectObservation({
    objectDescriptor,
    objectVersionSha256: value.objectVersionSha256,
    objectEtagSha256: value.objectEtagSha256,
    retainUntil: value.retainUntil,
    providerRequestIdSha256: value.providerRequestIdSha256,
    observedAt: value.observedAt,
  });
  canonicalEqual(rebuilt, value, "archive object observation");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormWriteObservationSubject({
  archivePolicy: policyInput,
  archiveManifest: manifestInput,
  writeOperationIdSha256,
  providerObservationSetSha256,
  observations: observationsInput,
  startedAt,
  lockedAt,
  completedAt,
}) {
  const policy = validateJsonCompatibilityExternalWormArchivePolicy(policyInput);
  const manifest = validateJsonCompatibilityExternalWormArchiveManifest(
    policy,
    manifestInput,
  );
  sha256(writeOperationIdSha256, "archive write operation");
  sha256(
    providerObservationSetSha256,
    "archive write provider observation set",
  );
  if (writeOperationIdSha256 === manifest.archiveOperationIdSha256) {
    fail("external_worm_operation_separation_invalid");
  }
  integer(startedAt, "archive write start time");
  integer(lockedAt, "archive lock time");
  integer(completedAt, "archive write completion time");
  if (
    startedAt < manifest.createdAt
    || lockedAt < startedAt
    || completedAt < lockedAt
  ) fail("external_worm_write_time_order_invalid");
  const observations = normalizeObservationSet(
    manifest.objects,
    observationsInput,
  );
  assertObservationTimes(observations, startedAt, completedAt);
  for (const observation of observations) {
    if (
      observation.retainUntil - lockedAt
        < JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS
    ) fail("external_worm_retention_invalid");
  }
  const actor = policy.writer;
  const identitySet = objectIdentitySet(observations);
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_EXTERNAL_WORM_WRITE_OBSERVATION_SUBJECT_CONTRACT,
    environment: "staging",
    attestationRole: "writer",
    archiveOperationIdSha256: manifest.archiveOperationIdSha256,
    writeOperationIdSha256,
    archivePolicySha256: policy.archivePolicySha256,
    archiveManifestSha256: manifest.archiveManifestSha256,
    accountBindingEvidenceSha256: manifest.accountBindingEvidenceSha256,
    attestorKeyId: actor.keyId,
    attestorSpkiSha256: actor.spkiSha256,
    principalIdentitySha256: actor.principalIdentitySha256,
    credentialIdSha256: actor.credentialIdSha256,
    permissionSetSha256: actor.permissionSetSha256,
    backendIdentitySha256: policy.backendIdentitySha256,
    namespaceIdentitySha256: policy.namespaceIdentitySha256,
    providerObservationSetSha256,
    observations,
    objectIdentitySetSha256: sha256Canonical(identitySet),
    objectObservationSetSha256: sha256Canonical(observations),
    objectCount: observations.length,
    totalByteLength: sumBytes(observations),
    retainUntil: minimumRetainUntil(observations),
    startedAt,
    lockedAt,
    completedAt,
  };
  return {
    ...subject,
    writeObservationSubjectSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormWriteObservationSubject(
  archivePolicy,
  archiveManifest,
  input,
) {
  const value = normalizeWriteSubjectDocument(input);
  const rebuilt = buildJsonCompatibilityExternalWormWriteObservationSubject({
    archivePolicy,
    archiveManifest,
    writeOperationIdSha256: value.writeOperationIdSha256,
    providerObservationSetSha256: value.providerObservationSetSha256,
    observations: value.observations,
    startedAt: value.startedAt,
    lockedAt: value.lockedAt,
    completedAt: value.completedAt,
  });
  canonicalEqual(rebuilt, value, "archive write observation subject");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormReadbackObservationSubject({
  archivePolicy: policyInput,
  archiveManifest: manifestInput,
  writeObservationEnvelope: writeEnvelopeInput,
  readbackOperationIdSha256,
  providerObservationSetSha256,
  observations: observationsInput,
  startedAt,
  completedAt,
}) {
  const policy = validateJsonCompatibilityExternalWormArchivePolicy(policyInput);
  const manifest = validateJsonCompatibilityExternalWormArchiveManifest(
    policy,
    manifestInput,
  );
  const writeEnvelope =
    validateJsonCompatibilityExternalWormAttestationEnvelope(
      writeEnvelopeInput,
    );
  equal(writeEnvelope.role, "writer", "archive write attestation role");
  const writeSubject =
    validateJsonCompatibilityExternalWormWriteObservationSubject(
      policy,
      manifest,
      writeEnvelope.subject,
    );
  sha256(readbackOperationIdSha256, "archive readback operation");
  sha256(
    providerObservationSetSha256,
    "archive readback provider observation set",
  );
  if (
    readbackOperationIdSha256 === manifest.archiveOperationIdSha256
    || readbackOperationIdSha256 === writeSubject.writeOperationIdSha256
  ) fail("external_worm_operation_separation_invalid");
  integer(startedAt, "archive readback start time");
  integer(completedAt, "archive readback completion time");
  const delay = startedAt - writeSubject.completedAt;
  if (
    delay < policy.minimumReadbackDelaySeconds
    || delay > policy.maximumReadbackDelaySeconds
    || completedAt < startedAt
  ) fail("external_worm_readback_window_invalid");
  const observations = normalizeObservationSet(
    manifest.objects,
    observationsInput,
  );
  assertObservationTimes(observations, startedAt, completedAt);
  assertExactReadback(writeSubject.observations, observations);
  const actor = policy.readback;
  const identitySet = objectIdentitySet(observations);
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract:
      JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_OBSERVATION_SUBJECT_CONTRACT,
    environment: "staging",
    attestationRole: "independent-readback",
    archiveOperationIdSha256: manifest.archiveOperationIdSha256,
    readbackOperationIdSha256,
    archivePolicySha256: policy.archivePolicySha256,
    archiveManifestSha256: manifest.archiveManifestSha256,
    writeObservationEnvelopeSha256:
      writeEnvelope.attestationEnvelopeSha256,
    accountBindingEvidenceSha256: manifest.accountBindingEvidenceSha256,
    attestorKeyId: actor.keyId,
    attestorSpkiSha256: actor.spkiSha256,
    principalIdentitySha256: actor.principalIdentitySha256,
    credentialIdSha256: actor.credentialIdSha256,
    permissionSetSha256: actor.permissionSetSha256,
    backendIdentitySha256: policy.backendIdentitySha256,
    namespaceIdentitySha256: policy.namespaceIdentitySha256,
    providerObservationSetSha256,
    readOnly: true,
    writePermissionsAbsent: true,
    deletePermissionsAbsent: true,
    retentionMutationPermissionsAbsent: true,
    observations,
    objectIdentitySetSha256: sha256Canonical(identitySet),
    objectObservationSetSha256: sha256Canonical(observations),
    objectCount: observations.length,
    totalByteLength: sumBytes(observations),
    retainUntil: minimumRetainUntil(observations),
    startedAt,
    completedAt,
  };
  return {
    ...subject,
    readbackObservationSubjectSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormReadbackObservationSubject(
  archivePolicy,
  archiveManifest,
  writeObservationEnvelope,
  input,
) {
  const value = normalizeReadbackSubjectDocument(input);
  const rebuilt = buildJsonCompatibilityExternalWormReadbackObservationSubject({
    archivePolicy,
    archiveManifest,
    writeObservationEnvelope,
    readbackOperationIdSha256: value.readbackOperationIdSha256,
    providerObservationSetSha256: value.providerObservationSetSha256,
    observations: value.observations,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  });
  canonicalEqual(rebuilt, value, "archive readback observation subject");
  return cloneJson(value);
}

export function buildJsonCompatibilityExternalWormAttestationEnvelope({
  subject: subjectInput,
  signerSpkiBase64url,
  signatureBase64url,
}) {
  const subject = normalizeAttestationSubject(subjectInput);
  const role = subject.attestationRole;
  const signer = normalizeSpki(
    signerSpkiBase64url,
    "archive attestation signer SPKI",
  );
  if (signer.sha256 !== subject.attestorSpkiSha256) {
    fail("external_worm_attestation_spki_digest_mismatch");
  }
  const signature = decodeCanonicalBase64url(
    signatureBase64url,
    "archive attestation signature",
  );
  if (signature.byteLength !== 64) {
    fail("external_worm_signature_encoding_invalid");
  }
  const envelopeSubject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_ATTESTATION_ENVELOPE_CONTRACT,
    environment: "staging",
    role,
    algorithm: "Ed25519",
    keyId: subject.attestorKeyId,
    signerSpkiBase64url,
    signerSpkiSha256: signer.sha256,
    subject,
    subjectSha256: subjectDigest(subject),
    signatureBase64url,
  };
  return {
    ...envelopeSubject,
    attestationEnvelopeSha256: sha256Canonical(envelopeSubject),
  };
}

export function validateJsonCompatibilityExternalWormAttestationEnvelope(
  input,
) {
  const value = record(input, "archive attestation envelope");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "role", "algorithm",
    "keyId", "signerSpkiBase64url", "signerSpkiSha256", "subject",
    "subjectSha256", "signatureBase64url", "attestationEnvelopeSha256",
  ], "archive attestation envelope");
  const rebuilt = buildJsonCompatibilityExternalWormAttestationEnvelope({
    subject: value.subject,
    signerSpkiBase64url: value.signerSpkiBase64url,
    signatureBase64url: value.signatureBase64url,
  });
  canonicalEqual(rebuilt, value, "archive attestation envelope");
  return cloneJson(value);
}

export function externalWormArchiveAttestationSigningPayload(subjectInput) {
  const subject = normalizeAttestationSubject(subjectInput);
  const domain = subject.attestationRole === "writer"
    ? JSON_COMPATIBILITY_EXTERNAL_WORM_WRITER_ATTESTATION_DOMAIN
    : JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN;
  return new TextEncoder().encode(`${domain}${canonicalJson(subject)}`);
}

export function verifyJsonCompatibilityExternalWormArchiveAttestation({
  archivePolicy: policyInput,
  envelope: envelopeInput,
  expectedArchivePolicySha256,
}) {
  const policy = validateJsonCompatibilityExternalWormArchivePolicy(policyInput);
  sha256(expectedArchivePolicySha256, "expected archive policy");
  if (policy.archivePolicySha256 !== expectedArchivePolicySha256) {
    fail("external_worm_attestation_policy_anchor_mismatch");
  }
  const envelope =
    validateJsonCompatibilityExternalWormAttestationEnvelope(envelopeInput);
  const actor = envelope.role === "writer" ? policy.writer : policy.readback;
  if (
    envelope.subject.archivePolicySha256 !== policy.archivePolicySha256
    || envelope.keyId !== actor.keyId
    || envelope.signerSpkiSha256 !== actor.spkiSha256
    || envelope.subject.principalIdentitySha256
      !== actor.principalIdentitySha256
    || envelope.subject.credentialIdSha256 !== actor.credentialIdSha256
    || envelope.subject.permissionSetSha256 !== actor.permissionSetSha256
  ) fail("external_worm_attestation_identity_mismatch");
  const key = publicKeyFromSpki(
    envelope.signerSpkiBase64url,
    "archive attestation signer SPKI",
  );
  const signature = decodeCanonicalBase64url(
    envelope.signatureBase64url,
    "archive attestation signature",
  );
  let valid = false;
  try {
    valid = verify(
      null,
      externalWormArchiveAttestationSigningPayload(envelope.subject),
      key,
      signature,
    );
  } catch {
    fail("external_worm_signature_verification_failed");
  }
  if (!valid) fail("external_worm_signature_invalid");
  return envelope;
}

export function buildJsonCompatibilityExternalWormArchiveEvidence({
  archivePolicy: policyInput,
  archiveManifest: manifestInput,
  writeObservationEnvelope: writeEnvelopeInput,
  independentReadbackEnvelope: readbackEnvelopeInput,
}) {
  const archivePolicy =
    validateJsonCompatibilityExternalWormArchivePolicy(policyInput);
  const archiveManifest =
    validateJsonCompatibilityExternalWormArchiveManifest(
      archivePolicy,
      manifestInput,
    );
  const writeObservationEnvelope =
    validateJsonCompatibilityExternalWormAttestationEnvelope(
      writeEnvelopeInput,
    );
  const independentReadbackEnvelope =
    validateJsonCompatibilityExternalWormAttestationEnvelope(
      readbackEnvelopeInput,
    );
  equal(
    writeObservationEnvelope.role,
    "writer",
    "archive evidence write role",
  );
  equal(
    independentReadbackEnvelope.role,
    "independent-readback",
    "archive evidence readback role",
  );
  const writeSubject =
    validateJsonCompatibilityExternalWormWriteObservationSubject(
      archivePolicy,
      archiveManifest,
      writeObservationEnvelope.subject,
    );
  const readbackSubject =
    validateJsonCompatibilityExternalWormReadbackObservationSubject(
      archivePolicy,
      archiveManifest,
      writeObservationEnvelope,
      independentReadbackEnvelope.subject,
    );
  canonicalEqual(
    writeSubject,
    writeObservationEnvelope.subject,
    "archive evidence write subject",
  );
  canonicalEqual(
    readbackSubject,
    independentReadbackEnvelope.subject,
    "archive evidence readback subject",
  );
  equal(
    writeSubject.objectIdentitySetSha256,
    readbackSubject.objectIdentitySetSha256,
    "archive evidence object identity set",
  );
  const subject = {
    schemaVersion: SCHEMA_VERSION,
    contract: JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_EVIDENCE_CONTRACT,
    kind: "container-runtime-json-compatibility-external-worm-archive-evidence",
    environment: "staging",
    archivePolicy,
    archiveManifest,
    writeObservationEnvelope,
    independentReadbackEnvelope,
    archivePolicySha256: archivePolicy.archivePolicySha256,
    archiveManifestSha256: archiveManifest.archiveManifestSha256,
    writeObservationEnvelopeSha256:
      writeObservationEnvelope.attestationEnvelopeSha256,
    independentReadbackEnvelopeSha256:
      independentReadbackEnvelope.attestationEnvelopeSha256,
    accountBindingEvidenceSha256:
      archiveManifest.accountBindingEvidenceSha256,
    accountBindingInventorySha256:
      archiveManifest.accountBindingInventorySha256,
    objectIdentitySetSha256: writeSubject.objectIdentitySetSha256,
    exactObjectReadback: true,
    independentWriterAndReader: true,
    complianceRetentionVerified: true,
    observedAt: readbackSubject.completedAt,
  };
  return {
    ...subject,
    archiveEvidenceSha256: sha256Canonical(subject),
  };
}

export function validateJsonCompatibilityExternalWormArchiveEvidence(input) {
  const value = record(input, "archive evidence");
  exactKeys(value, [
    "schemaVersion", "contract", "kind", "environment", "archivePolicy",
    "archiveManifest", "writeObservationEnvelope",
    "independentReadbackEnvelope", "archivePolicySha256",
    "archiveManifestSha256", "writeObservationEnvelopeSha256",
    "independentReadbackEnvelopeSha256", "accountBindingEvidenceSha256",
    "accountBindingInventorySha256", "objectIdentitySetSha256",
    "exactObjectReadback", "independentWriterAndReader",
    "complianceRetentionVerified", "observedAt", "archiveEvidenceSha256",
  ], "archive evidence");
  const rebuilt = buildJsonCompatibilityExternalWormArchiveEvidence({
    archivePolicy: value.archivePolicy,
    archiveManifest: value.archiveManifest,
    writeObservationEnvelope: value.writeObservationEnvelope,
    independentReadbackEnvelope: value.independentReadbackEnvelope,
  });
  canonicalEqual(rebuilt, value, "archive evidence");
  return cloneJson(value);
}

export function verifyJsonCompatibilityExternalWormArchiveEvidence(
  input,
  {
    expectedArchivePolicySha256,
    forbiddenSignerSpkiSha256s = [],
  },
) {
  const evidence = validateJsonCompatibilityExternalWormArchiveEvidence(input);
  sha256(expectedArchivePolicySha256, "expected archive policy");
  const forbidden = normalizeDigestSet(
    forbiddenSignerSpkiSha256s,
    "forbidden archive signer SPKI",
  );
  if (
    forbidden.includes(evidence.archivePolicy.writer.spkiSha256)
    || forbidden.includes(evidence.archivePolicy.readback.spkiSha256)
  ) fail("external_worm_cross_domain_signer_reuse");
  verifyJsonCompatibilityExternalWormArchiveAttestation({
    archivePolicy: evidence.archivePolicy,
    envelope: evidence.writeObservationEnvelope,
    expectedArchivePolicySha256,
  });
  verifyJsonCompatibilityExternalWormArchiveAttestation({
    archivePolicy: evidence.archivePolicy,
    envelope: evidence.independentReadbackEnvelope,
    expectedArchivePolicySha256,
  });
  return evidence;
}

function normalizeTrustActor(input, label) {
  const value = record(input, `archive ${label} trust actor`);
  exactKeys(value, [
    "keyId", "spkiSha256", "spkiBase64url", "principalIdentitySha256",
    "credentialIdSha256", "permissionSetSha256",
  ], `archive ${label} trust actor`);
  safeToken(value.keyId, `archive ${label} key ID`);
  const spki = normalizeSpki(
    value.spkiBase64url,
    `archive ${label} SPKI`,
  );
  sha256(value.spkiSha256, `archive ${label} SPKI digest`);
  if (spki.sha256 !== value.spkiSha256) {
    fail("external_worm_attestation_spki_digest_mismatch");
  }
  sha256(value.principalIdentitySha256, `archive ${label} principal identity`);
  sha256(value.credentialIdSha256, `archive ${label} credential ID`);
  sha256(value.permissionSetSha256, `archive ${label} permission set`);
  return cloneJson(value);
}

function assertActorSeparation(writer, readback) {
  for (const property of [
    "keyId",
    "spkiSha256",
    "principalIdentitySha256",
    "credentialIdSha256",
    "permissionSetSha256",
  ]) {
    if (writer[property] === readback[property]) {
      fail("external_worm_policy_identity_separation_invalid");
    }
  }
}

function assertPassSeparation(collection, readback) {
  for (const property of [
    "credentialReceiptSha256",
    "custodianIdentitySha256",
    "authenticationIdentitySha256",
    "collectionArtifactSha256",
    "snapshotSha256",
    "pageChainHeadSha256",
    "captureManifestSha256",
    "captureTerminalSha256",
    "passObjectSetSha256",
    "passRootSha256",
  ]) {
    if (collection[property] === readback[property]) {
      fail("external_worm_pass_identity_separation_invalid");
    }
  }
}

function assertPassObjectClosure(objects, mode, roots) {
  const capture = objects.filter(
    (value) => value.logicalRole === "capture-manifest",
  );
  const terminal = objects.filter(
    (value) => value.logicalRole === "capture-terminal",
  );
  const artifact = objects.filter(
    (value) => value.logicalRole === "collection-artifact",
  );
  const bodies = objects.filter(
    (value) => value.logicalRole === "raw-response-body",
  ).sort(compareSequence);
  const receipts = objects.filter(
    (value) => value.logicalRole === "page-receipt",
  ).sort(compareSequence);
  if (
    capture.length !== 1
    || terminal.length !== 1
    || artifact.length !== 1
    || bodies.length < 1
  ) {
    fail("external_worm_pass_object_set_invalid");
  }
  if (
    capture[0].contentIdentitySha256 !== roots.captureManifestSha256
    || terminal[0].contentIdentitySha256 !== roots.captureTerminalSha256
    || artifact[0].contentIdentitySha256 !== roots.collectionArtifactSha256
    || receipts.length !== bodies.length
  ) fail("external_worm_pass_object_set_mismatch");
  for (let index = 0; index < bodies.length; index += 1) {
    const expectedSequence = index + 1;
    const body = bodies[index];
    const receipt = receipts[index];
    if (
      body.mode !== mode
      || receipt.mode !== mode
      || body.sequence !== expectedSequence
      || receipt.sequence !== expectedSequence
      || body.resourceFamily !== receipt.resourceFamily
      || body.pageReceiptSha256 !== receipt.pageReceiptSha256
      || receipt.contentIdentitySha256 !== receipt.pageReceiptSha256
    ) fail("external_worm_page_object_pair_invalid");
  }
  return {
    pageCount: bodies.length,
    rawResponseByteLength: sumBytes(bodies),
  };
}

function assertGlobalObject(objects, role, expectedIdentity) {
  const matches = objects.filter((value) => value.logicalRole === role);
  if (
    matches.length !== 1
    || matches[0].mode !== null
    || matches[0].contentIdentitySha256 !== expectedIdentity
  ) fail("external_worm_global_object_set_invalid");
}

function normalizeDescriptorSet(input) {
  if (!Array.isArray(input) || input.length < 1) {
    fail("external_worm_object_set_invalid");
  }
  if (
    input.length > JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_OBJECT_COUNT
  ) fail("external_worm_archive_object_count_limit_exceeded");
  const values = input.map(
    validateJsonCompatibilityExternalWormArchiveObjectDescriptor,
  ).sort(compareObjectKey);
  rejectDuplicates(
    values,
    (value) => value.objectKeySha256,
    "external_worm_object_key_duplicate",
  );
  rejectDuplicates(
    values,
    (value) => value.objectDescriptorSha256,
    "external_worm_object_descriptor_duplicate",
  );
  return values;
}

function normalizeObservationSet(descriptors, input) {
  if (!Array.isArray(input) || input.length !== descriptors.length) {
    fail("external_worm_observation_set_invalid");
  }
  const descriptorMap = new Map(
    descriptors.map((value) => [value.objectDescriptorSha256, value]),
  );
  const values = input.map((entry) => {
    const shape = normalizeObjectObservationDocument(entry);
    const descriptor = descriptorMap.get(shape.objectDescriptorSha256);
    if (descriptor === undefined) fail("external_worm_observation_object_unknown");
    return validateJsonCompatibilityExternalWormArchiveObjectObservation(
      descriptor,
      shape,
    );
  }).sort(compareObjectKey);
  rejectDuplicates(
    values,
    (value) => value.objectDescriptorSha256,
    "external_worm_observation_object_duplicate",
  );
  rejectDuplicates(
    values,
    (value) => value.objectKeySha256,
    "external_worm_observation_object_duplicate",
  );
  rejectDuplicates(
    values,
    (value) => value.providerRequestIdSha256,
    "external_worm_provider_request_duplicate",
  );
  return values;
}

function normalizeObjectObservationDocument(input) {
  const value = record(input, "archive object observation");
  exactKeys(value, [
    "schemaVersion", "contract", "objectDescriptorSha256",
    "objectKeySha256", "objectVersionSha256", "objectEtagSha256",
    "bodySha256", "byteLength", "retentionMode", "retainUntil",
    "providerRequestIdSha256", "observedAt", "objectObservationSha256",
  ], "archive object observation");
  equal(value.schemaVersion, SCHEMA_VERSION, "archive observation schema");
  equal(
    value.contract,
    JSON_COMPATIBILITY_EXTERNAL_WORM_ARCHIVE_OBJECT_OBSERVATION_CONTRACT,
    "archive observation contract",
  );
  for (const [label, digest] of [
    ["descriptor", value.objectDescriptorSha256],
    ["key", value.objectKeySha256],
    ["version", value.objectVersionSha256],
    ["ETag", value.objectEtagSha256],
    ["body", value.bodySha256],
    ["provider request", value.providerRequestIdSha256],
    ["observation", value.objectObservationSha256],
  ]) sha256(digest, `archive observation ${label}`);
  positiveInteger(value.byteLength, "archive observation byte length");
  equal(value.retentionMode, "compliance", "archive retention mode");
  integer(value.retainUntil, "archive observation retention time");
  integer(value.observedAt, "archive observation time");
  const subject = without(value, "objectObservationSha256");
  equal(
    sha256Canonical(subject),
    value.objectObservationSha256,
    "archive object observation digest",
  );
  return cloneJson(value);
}

function normalizeWriteSubjectDocument(input) {
  const value = record(input, "archive write observation subject");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "attestationRole",
    "archiveOperationIdSha256", "writeOperationIdSha256",
    "archivePolicySha256", "archiveManifestSha256",
    "accountBindingEvidenceSha256", "attestorKeyId", "attestorSpkiSha256",
    "principalIdentitySha256", "credentialIdSha256", "permissionSetSha256",
    "backendIdentitySha256", "namespaceIdentitySha256",
    "providerObservationSetSha256", "observations",
    "objectIdentitySetSha256", "objectObservationSetSha256", "objectCount",
    "totalByteLength", "retainUntil", "startedAt", "lockedAt",
    "completedAt", "writeObservationSubjectSha256",
  ], "archive write observation subject");
  equal(value.schemaVersion, SCHEMA_VERSION, "archive write schema");
  equal(
    value.contract,
    JSON_COMPATIBILITY_EXTERNAL_WORM_WRITE_OBSERVATION_SUBJECT_CONTRACT,
    "archive write contract",
  );
  equal(value.environment, "staging", "archive write environment");
  equal(value.attestationRole, "writer", "archive write role");
  validateCommonSubjectFields(value, "archive write");
  sha256(value.writeOperationIdSha256, "archive write operation");
  integer(value.lockedAt, "archive write lock time");
  sha256(
    value.writeObservationSubjectSha256,
    "archive write subject digest",
  );
  if (value.lockedAt < value.startedAt || value.completedAt < value.lockedAt) {
    fail("external_worm_write_time_order_invalid");
  }
  equal(
    sha256Canonical(without(value, "writeObservationSubjectSha256")),
    value.writeObservationSubjectSha256,
    "archive write subject digest",
  );
  return cloneJson(value);
}

function normalizeReadbackSubjectDocument(input) {
  const value = record(input, "archive readback observation subject");
  exactKeys(value, [
    "schemaVersion", "contract", "environment", "attestationRole",
    "archiveOperationIdSha256", "readbackOperationIdSha256",
    "archivePolicySha256", "archiveManifestSha256",
    "writeObservationEnvelopeSha256", "accountBindingEvidenceSha256",
    "attestorKeyId", "attestorSpkiSha256", "principalIdentitySha256",
    "credentialIdSha256", "permissionSetSha256", "backendIdentitySha256",
    "namespaceIdentitySha256", "providerObservationSetSha256",
    "readOnly", "writePermissionsAbsent",
    "deletePermissionsAbsent", "retentionMutationPermissionsAbsent",
    "observations", "objectIdentitySetSha256",
    "objectObservationSetSha256", "objectCount", "totalByteLength",
    "retainUntil", "startedAt", "completedAt",
    "readbackObservationSubjectSha256",
  ], "archive readback observation subject");
  equal(value.schemaVersion, SCHEMA_VERSION, "archive readback schema");
  equal(
    value.contract,
    JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_OBSERVATION_SUBJECT_CONTRACT,
    "archive readback contract",
  );
  equal(value.environment, "staging", "archive readback environment");
  equal(
    value.attestationRole,
    "independent-readback",
    "archive readback role",
  );
  validateCommonSubjectFields(value, "archive readback");
  sha256(value.readbackOperationIdSha256, "archive readback operation");
  sha256(
    value.writeObservationEnvelopeSha256,
    "archive write observation envelope",
  );
  for (const property of [
    "readOnly",
    "writePermissionsAbsent",
    "deletePermissionsAbsent",
    "retentionMutationPermissionsAbsent",
  ]) equal(value[property], true, `archive readback ${property}`);
  sha256(
    value.readbackObservationSubjectSha256,
    "archive readback subject digest",
  );
  if (value.completedAt < value.startedAt) {
    fail("external_worm_readback_time_order_invalid");
  }
  equal(
    sha256Canonical(without(value, "readbackObservationSubjectSha256")),
    value.readbackObservationSubjectSha256,
    "archive readback subject digest",
  );
  return cloneJson(value);
}

function validateCommonSubjectFields(value, label) {
  for (const [name, digest] of [
    ["archive operation", value.archiveOperationIdSha256],
    ["archive policy", value.archivePolicySha256],
    ["archive manifest", value.archiveManifestSha256],
    ["account binding evidence", value.accountBindingEvidenceSha256],
    ["attestor SPKI", value.attestorSpkiSha256],
    ["principal identity", value.principalIdentitySha256],
    ["credential ID", value.credentialIdSha256],
    ["permission set", value.permissionSetSha256],
    ["backend identity", value.backendIdentitySha256],
    ["namespace identity", value.namespaceIdentitySha256],
    ["provider observation set", value.providerObservationSetSha256],
    ["object identity set", value.objectIdentitySetSha256],
    ["object observation set", value.objectObservationSetSha256],
  ]) sha256(digest, `${label} ${name}`);
  safeToken(value.attestorKeyId, `${label} attestor key ID`);
  if (!Array.isArray(value.observations) || value.observations.length < 1) {
    fail("external_worm_observation_set_invalid");
  }
  const observations = value.observations.map(normalizeObjectObservationDocument)
    .sort(compareObjectKey);
  canonicalEqual(observations, value.observations, `${label} observations`);
  positiveInteger(value.objectCount, `${label} object count`);
  positiveInteger(value.totalByteLength, `${label} total byte length`);
  integer(value.retainUntil, `${label} retention time`);
  integer(value.startedAt, `${label} start time`);
  integer(value.completedAt, `${label} completion time`);
  equal(value.objectCount, observations.length, `${label} object count`);
  equal(value.totalByteLength, sumBytes(observations), `${label} byte length`);
  equal(
    value.retainUntil,
    minimumRetainUntil(observations),
    `${label} retention minimum`,
  );
  equal(
    value.objectIdentitySetSha256,
    sha256Canonical(objectIdentitySet(observations)),
    `${label} object identity set`,
  );
  equal(
    value.objectObservationSetSha256,
    sha256Canonical(observations),
    `${label} object observation set`,
  );
}

function normalizeAttestationSubject(input) {
  if (
    input?.contract
      === JSON_COMPATIBILITY_EXTERNAL_WORM_WRITE_OBSERVATION_SUBJECT_CONTRACT
  ) return normalizeWriteSubjectDocument(input);
  if (
    input?.contract
      === JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_OBSERVATION_SUBJECT_CONTRACT
  ) return normalizeReadbackSubjectDocument(input);
  fail("external_worm_attestation_subject_contract_invalid");
}

function subjectDigest(subject) {
  return subject.attestationRole === "writer"
    ? subject.writeObservationSubjectSha256
    : subject.readbackObservationSubjectSha256;
}

function assertObservationTimes(observations, startedAt, completedAt) {
  for (const observation of observations) {
    if (
      observation.observedAt < startedAt
      || observation.observedAt > completedAt
    ) fail("external_worm_observation_time_order_invalid");
  }
}

function assertExactReadback(writeObservations, readbackObservations) {
  const writeMap = new Map(
    writeObservations.map((value) => [value.objectKeySha256, value]),
  );
  for (const readback of readbackObservations) {
    const written = writeMap.get(readback.objectKeySha256);
    if (
      written === undefined
      || canonicalJson(objectIdentity(written))
        !== canonicalJson(objectIdentity(readback))
      || readback.retainUntil < written.retainUntil
      || readback.providerRequestIdSha256 === written.providerRequestIdSha256
    ) fail("external_worm_readback_observation_mismatch");
  }
}

function objectIdentitySet(observations) {
  return observations.map(objectIdentity).sort((left, right) =>
    compareAscii(left.objectKeySha256, right.objectKeySha256));
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

function normalizeSpki(value, label) {
  const bytes = decodeCanonicalBase64url(value, label);
  if (bytes.byteLength < 1 || bytes.byteLength > 512) {
    fail("external_worm_attestation_spki_invalid");
  }
  const key = publicKeyFromBytes(bytes);
  const exported = key.export({ format: "der", type: "spki" });
  if (!Buffer.from(exported).equals(bytes)) {
    fail("external_worm_attestation_spki_not_canonical");
  }
  return { sha256: sha256Bytes(bytes) };
}

function publicKeyFromSpki(value, label) {
  return publicKeyFromBytes(decodeCanonicalBase64url(value, label));
}

function publicKeyFromBytes(bytes) {
  let key;
  try {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    fail("external_worm_attestation_spki_invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    fail("external_worm_attestation_key_type_invalid");
  }
  return key;
}

function decodeCanonicalBase64url(value, label) {
  if (
    typeof value !== "string"
    || value.length < 1
    || !BASE64URL.test(value)
    || value.includes("=")
  ) fail("external_worm_base64url_invalid", `${label} is invalid`);
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    fail("external_worm_base64url_invalid", `${label} is invalid`);
  }
  if (bytes.toString("base64url") !== value) {
    fail("external_worm_base64url_not_canonical", `${label} is not canonical`);
  }
  return bytes;
}

function normalizeDigestSet(input, label) {
  if (!Array.isArray(input)) fail("external_worm_digest_set_invalid");
  const values = [...input];
  for (const value of values) sha256(value, label);
  values.sort(compareAscii);
  rejectDuplicates(
    values,
    (value) => value,
    "external_worm_digest_set_duplicate",
  );
  return values;
}

function minimumRetainUntil(values) {
  return Math.min(...values.map((value) => value.retainUntil));
}

function sumBytes(values) {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  if (!Number.isSafeInteger(total) || total < 1) {
    fail("external_worm_total_byte_length_invalid");
  }
  return total;
}

function sumArchiveBytes(values) {
  let total = 0;
  for (const value of values) {
    if (
      value.byteLength
      > JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_TOTAL_BYTES - total
    ) fail("external_worm_archive_total_bytes_limit_exceeded");
    total += value.byteLength;
  }
  if (total < 1) fail("external_worm_total_byte_length_invalid");
  return total;
}

function compareObjectKey(left, right) {
  return compareAscii(left.objectKeySha256, right.objectKeySha256);
}

function compareSequence(left, right) {
  return left.sequence - right.sequence;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectDuplicates(values, key, code) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) fail(code);
    seen.add(identity);
  }
}

function collectionMode(value) {
  if (value !== "collection" && value !== "independent-readback") {
    fail("external_worm_collection_mode_invalid");
  }
  return value;
}

function nullableMode(value) {
  if (value !== null) collectionMode(value);
  return value;
}

function nullableSafeToken(value, label) {
  if (value !== null) safeToken(value, label);
  return value;
}

function nullableSha256(value, label) {
  if (value !== null) sha256(value, label);
  return value;
}

function nullablePositiveInteger(value, label) {
  if (value !== null) positiveInteger(value, label);
  return value;
}

function record(value, label) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) fail("external_worm_document_invalid", `${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareAscii);
  const wanted = [...expected].sort(compareAscii);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail("external_worm_document_keys_invalid", `${label} has invalid keys`);
  }
}

function canonicalEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("external_worm_binding_mismatch", `${label} does not match`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    fail("external_worm_binding_mismatch", `${label} does not match`);
  }
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("external_worm_digest_invalid", `${label} must be SHA-256`);
  }
  return value;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeToken(value, label) {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    fail("external_worm_token_invalid", `${label} is invalid`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("external_worm_integer_invalid", `${label} must be an integer`);
  }
  return value;
}

function positiveInteger(value, label) {
  integer(value, label);
  if (value < 1) {
    fail("external_worm_integer_invalid", `${label} must be positive`);
  }
  return value;
}

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function fail(code, message = code) {
  throw new JsonCompatibilityExternalWormArchiveError(code, message);
}
