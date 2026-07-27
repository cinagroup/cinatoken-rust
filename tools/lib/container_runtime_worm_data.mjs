import { createHash } from "node:crypto";

import {
  PUBLISHER_ACCESS_KEY_ENV,
  PUBLISHER_SECRET_KEY_ENV,
  WORM_STAGING_RECEIPT_CONTRACT,
  WORM_STAGING_SCHEMA_VERSION,
  canonicalJson,
} from "./container_runtime_worm_staging.mjs";
import {
  WORM_LIFECYCLE_RECEIPT_CONTRACT,
  WORM_LIFECYCLE_SCHEMA_VERSION,
} from "./container_runtime_worm_lifecycle.mjs";

export const WORM_DATA_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-worm-data-phase-receipt-v1";
export const WORM_DATA_SCHEMA_VERSION = 1;
export const OBJECT_VERIFIER_ACCESS_KEY_ENV =
  "CINATOKEN_WORM_OBJECT_VERIFIER_R2_ACCESS_KEY_ID";
export const OBJECT_VERIFIER_SECRET_KEY_ENV =
  "CINATOKEN_WORM_OBJECT_VERIFIER_R2_SECRET_ACCESS_KEY";

export const WORM_OBJECTS = Object.freeze([
  Object.freeze({
    kind: "source-evidence-packet",
    fileName: "container-runtime-source-evidence.zip",
    contentType: "application/zip",
  }),
  Object.freeze({
    kind: "provenance-evidence-packet",
    fileName: "container-runtime-provenance-evidence.zip",
    contentType: "application/zip",
  }),
  Object.freeze({
    kind: "provenance-statement",
    fileName: "container-runtime.provenance.slsa.json",
    contentType: "application/json",
  }),
  Object.freeze({
    kind: "sigstore-bundle",
    fileName: "container-runtime.provenance.sigstore.json",
    contentType: "application/json",
  }),
  Object.freeze({
    kind: "provenance-report",
    fileName: "container-runtime-provenance-verification.json",
    contentType: "application/json",
  }),
  Object.freeze({
    kind: "cosign-verification-log",
    fileName: "cosign-verification.log",
    contentType: "text/plain; charset=utf-8",
  }),
]);

const MANIFEST_CONTRACT =
  "cinatoken-container-runtime-worm-retention-manifest-v2";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES = 768 * 1024 * 1024;
const MAX_LIST_PAGES = 1_000;
const MAX_LIST_ITEMS = 10_000;
const MAX_MULTIPART_UPLOADS = 10_000;

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const BUCKET_NAME_PATTERN =
  /^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const E_TAG_PATTERN = /^.{1,256}$/s;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export class WormDataCollectorError extends Error {
  constructor(message) {
    super(message);
    this.name = "WormDataCollectorError";
  }
}

export function describeDataCollector() {
  return {
    schemaVersion: WORM_DATA_SCHEMA_VERSION,
    contract: WORM_DATA_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-data-collector",
    environment: "staging",
    defaultMode: "dry-run",
    phases: [
      {
        phase: "publish",
        providerMutation: true,
        writesFiles: false,
        credentialRole: "publisher",
        credentialEnvironment: [
          PUBLISHER_ACCESS_KEY_ENV,
          PUBLISHER_SECRET_KEY_ENV,
        ],
        requests: WORM_OBJECTS.map(() => "PutObject If-None-Match:*"),
      },
      {
        phase: "readback",
        providerMutation: false,
        writesFiles: true,
        credentialRole: "object-verifier",
        credentialEnvironment: [
          OBJECT_VERIFIER_ACCESS_KEY_ENV,
          OBJECT_VERIFIER_SECRET_KEY_ENV,
        ],
        requests: [
          "ListObjectsV2 all pages",
          "ListMultipartUploads all pages",
          ...WORM_OBJECTS.map(() => "GetObject"),
        ],
      },
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

export function readDataCredentials(phase, env) {
  const names =
    phase === "publish"
      ? [PUBLISHER_ACCESS_KEY_ENV, PUBLISHER_SECRET_KEY_ENV]
      : phase === "readback"
        ? [
            OBJECT_VERIFIER_ACCESS_KEY_ENV,
            OBJECT_VERIFIER_SECRET_KEY_ENV,
          ]
        : null;
  requireCondition(names !== null, "[credentials] unsupported data phase");
  const accessKeyId = requireCredential(env[names[0]], names[0]);
  const secretAccessKey = requireCredential(env[names[1]], names[1]);
  requireCondition(
    accessKeyId !== secretAccessKey,
    "[credentials] access and secret key values must differ",
  );
  return {
    accessKeyId,
    secretAccessKey,
    credentialIdSha256: sha256Text(accessKeyId),
  };
}

export function normalizePublishPredecessors(options) {
  const accountId = requirePattern(
    options.accountId,
    ACCOUNT_ID_PATTERN,
    "[input] account ID",
  );
  const baselineText = requireCanonicalReceipt(
    options.baselineReceipt,
    options.baselineReceiptText,
    "baseline receipt",
  );
  const baseline = normalizeBaselineReceipt(
    options.baselineReceipt,
    accountId,
  );
  const revocationText = requireCanonicalReceipt(
    options.lockRevocationReceipt,
    options.lockRevocationReceiptText,
    "lock revocation receipt",
  );
  const revocation = normalizeLockRevocationReceipt(
    options.lockRevocationReceipt,
    accountId,
  );
  requireSameTarget(baseline, revocation, "publish predecessors");
  requireCondition(
    baseline.capturedAt < revocation.lockCapturedAt &&
      revocation.lockCapturedAt < revocation.revokeCapturedAt &&
      revocation.revokeCapturedAt <
        revocation.verifierSelfVerifiedAt &&
      revocation.verifierSelfVerifiedAt < revocation.capturedAt,
    "[predecessor] B1-B3 chronology is invalid",
  );
  return {
    accountId,
    accountIdSha256: baseline.accountIdSha256,
    bucketName: baseline.bucketName,
    jurisdiction: baseline.jurisdiction,
    prefix: baseline.prefix,
    statementSha256: baseline.statementSha256,
    publisherCredentialIdSha256:
      baseline.publisherCredentialIdSha256,
    baselineObservedAt: baseline.capturedAt,
    baselineReceiptSha256: sha256Text(baselineText),
    lockCapturedAt: revocation.lockCapturedAt,
    lockOperatorCredentialIdSha256:
      revocation.targetCredentialIdSha256,
    lockRevocationObservedAt: revocation.capturedAt,
    lockRevocationReceiptSha256: sha256Text(revocationText),
  };
}

export function normalizeArtifactDescriptors(artifacts, target) {
  requireCondition(
    Array.isArray(artifacts) &&
      artifacts.length === WORM_OBJECTS.length,
    "[artifacts] exactly six object descriptors are required",
  );
  let totalBytes = 0;
  const normalized = [];
  for (let index = 0; index < WORM_OBJECTS.length; index += 1) {
    const expected = WORM_OBJECTS[index];
    const artifact = requireObject(
      artifacts[index],
      `[artifacts] ${expected.kind}`,
    );
    requireCondition(
      artifact.kind === expected.kind &&
        artifact.fileName === expected.fileName &&
        artifact.contentType === expected.contentType &&
        Number.isSafeInteger(artifact.bytes) &&
        artifact.bytes > 0 &&
        artifact.bytes <= MAX_OBJECT_BYTES &&
        SHA256_PATTERN.test(artifact.sha256) &&
        validContentMd5(artifact.contentMd5Base64) &&
        typeof artifact.bodyFactory === "function",
      `[artifacts] ${expected.kind} descriptor drifted`,
    );
    if (expected.kind === "provenance-statement") {
      requireCondition(
        artifact.sha256 === target.statementSha256,
        "[artifacts] provenance statement digest drifted",
      );
    }
    totalBytes += artifact.bytes;
    requireCondition(
      totalBytes <= MAX_TOTAL_OBJECT_BYTES,
      "[artifacts] aggregate byte bound exceeded",
    );
    normalized.push({
      kind: expected.kind,
      fileName: expected.fileName,
      contentType: expected.contentType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      contentMd5Base64: artifact.contentMd5Base64,
      bodyFactory: artifact.bodyFactory,
    });
  }
  return normalized;
}

export function buildDataDryRunReceipt(phase, target, artifacts = null) {
  requirePhase(phase);
  if (phase === "publish") {
    requireCondition(
      Array.isArray(artifacts) &&
        artifacts.length === WORM_OBJECTS.length,
      "[dry-run] publish requires the exact artifact set",
    );
  }
  return {
    schemaVersion: WORM_DATA_SCHEMA_VERSION,
    contract: WORM_DATA_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-data-collector",
    environment: "staging",
    phase,
    mode: "dry-run",
    ok: true,
    capturedAt: null,
    networkRequests: false,
    credentialsRead: false,
    writesFiles: false,
    providerMutationConfirmed: false,
    providerMutationPerformed: false,
    target: publicTarget(target),
    requestPlan:
      phase === "publish"
        ? artifacts.map((artifact) => ({
            operation: "PutObject",
            condition: "If-None-Match:*",
            key: `${target.prefix}${artifact.fileName}`,
            bytes: artifact.bytes,
            sha256: artifact.sha256,
          }))
        : [
            "ListObjectsV2 all pages",
            "ListMultipartUploads all pages",
            ...WORM_OBJECTS.map(
              (value) => `GetObject ${target.prefix}${value.fileName}`,
            ),
          ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

export async function publishCreateOnlyObjects(options) {
  const {
    target,
    artifacts,
    credentials,
    commitSha,
    s3,
    now = () => new Date(),
  } = options;
  requireCondition(
    s3 && typeof s3.putObject === "function",
    "[publish] S3 adapter is incomplete",
  );
  requirePattern(commitSha, COMMIT_SHA_PATTERN, "[publish] commit SHA");
  requireCondition(
    credentials.credentialIdSha256 ===
      target.publisherCredentialIdSha256,
    "[publish] publisher credential does not match the baseline",
  );
  const normalizedArtifacts = normalizeArtifactDescriptors(
    artifacts,
    target,
  );
  const records = [];
  const operations = [];
  let previousUploadedAt = target.lockRevocationObservedAt;
  for (const artifact of normalizedArtifacts) {
    let body;
    try {
      body = artifact.bodyFactory();
    } catch {
      throw new WormDataCollectorError(
        `[publish] ${artifact.kind} body could not be opened`,
      );
    }
    requireCondition(
      body !== null && body !== undefined,
      `[publish] ${artifact.kind} body is unavailable`,
    );
    const response = await invokeAdapter(
      (abortSignal) =>
        s3.putObject(
          {
            Bucket: target.bucketName,
            Key: `${target.prefix}${artifact.fileName}`,
            Body: body,
            ContentLength: artifact.bytes,
            ContentType: artifact.contentType,
            ContentMD5: artifact.contentMd5Base64,
            IfNoneMatch: "*",
            Metadata: {
              contract: MANIFEST_CONTRACT,
              repositorycommit: commitSha,
              sha256: artifact.sha256,
            },
          },
          abortSignal,
        ),
      `PutObject ${artifact.kind}`,
    );
    const metadata = requireSuccessMetadata(
      response,
      `PutObject ${artifact.kind}`,
    );
    requireCondition(
      typeof response.ETag === "string" &&
        E_TAG_PATTERN.test(response.ETag),
      `[publish] ${artifact.kind} ETag is absent`,
    );
    const uploadedAt = requireTimestamp(
      now(),
      `[publish] ${artifact.kind} upload time`,
    );
    requireCondition(
      target.lockRevocationObservedAt < uploadedAt &&
        previousUploadedAt <= uploadedAt,
      `[publish] ${artifact.kind} upload chronology is invalid`,
    );
    previousUploadedAt = uploadedAt;
    const key = `${target.prefix}${artifact.fileName}`;
    records.push({
      kind: artifact.kind,
      fileName: artifact.fileName,
      key,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      etag: response.ETag,
      contentType: artifact.contentType,
      uploadedAt,
      uploadHttpStatus: metadata.httpStatus,
      uploadRequestId: metadata.providerRequestId,
      customMetadata: {
        contract: MANIFEST_CONTRACT,
        repositoryCommit: commitSha,
        sha256: artifact.sha256,
      },
    });
    operations.push({
      operation: "PutObject",
      condition: "If-None-Match:*",
      kind: artifact.kind,
      key,
      httpStatus: metadata.httpStatus,
      providerRequestId: metadata.providerRequestId,
      etag: response.ETag,
    });
  }
  const capturedAt = records.at(-1).uploadedAt;
  const receipt = {
    schemaVersion: WORM_DATA_SCHEMA_VERSION,
    contract: WORM_DATA_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-data-collector",
    environment: "staging",
    phase: "publish",
    mode: "live",
    ok: true,
    capturedAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    providerMutationConfirmed: true,
    providerMutationPerformed: true,
    target: publicTarget(target),
    predecessors: {
      baselineReceiptSha256: target.baselineReceiptSha256,
      baselineObservedAt: target.baselineObservedAt,
      lockRevocationReceiptSha256:
        target.lockRevocationReceiptSha256,
      lockRevocationObservedAt: target.lockRevocationObservedAt,
    },
    credential: {
      role: "publisher",
      credentialType: "r2-object-read-write-api-token",
      credentialIdSha256: credentials.credentialIdSha256,
    },
    facts: {
      createOnlyWritesVerified: true,
      awsS3ObjectLockHeadersUsed: false,
      objects: records,
    },
    providerOperations: operations,
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    target.accountId,
  ]);
  return receipt;
}

export function normalizeReadbackPredecessor(options) {
  const accountId = requirePattern(
    options.accountId,
    ACCOUNT_ID_PATTERN,
    "[input] account ID",
  );
  const receiptText = requireCanonicalReceipt(
    options.publishReceipt,
    options.publishReceiptText,
    "publish receipt",
  );
  const receipt = requireObject(
    options.publishReceipt,
    "[predecessor] publish receipt",
  );
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "contract",
      "source",
      "environment",
      "phase",
      "mode",
      "ok",
      "capturedAt",
      "networkRequests",
      "credentialsRead",
      "writesFiles",
      "providerMutationConfirmed",
      "providerMutationPerformed",
      "target",
      "predecessors",
      "credential",
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    "[predecessor] publish receipt",
  );
  requireCondition(
    receipt.schemaVersion === WORM_DATA_SCHEMA_VERSION &&
      receipt.contract === WORM_DATA_RECEIPT_CONTRACT &&
      receipt.source ===
        "cinatoken-container-runtime-worm-data-collector" &&
      receipt.environment === "staging" &&
      receipt.phase === "publish" &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === false &&
      receipt.providerMutationConfirmed === true &&
      receipt.providerMutationPerformed === true,
    "[predecessor] publish authority is invalid",
  );
  exactKeys(
    receipt.target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "statementSha256",
    ],
    "[predecessor] publish target",
  );
  const target = normalizePublicTarget(receipt.target, accountId);
  const capturedAt = requireCanonicalTimestamp(
    receipt.capturedAt,
    "[predecessor] publish capture time",
  );
  const predecessors = requireObject(
    receipt.predecessors,
    "[predecessor] publish predecessors",
  );
  exactKeys(
    predecessors,
    [
      "baselineReceiptSha256",
      "baselineObservedAt",
      "lockRevocationReceiptSha256",
      "lockRevocationObservedAt",
    ],
    "[predecessor] publish predecessors",
  );
  const baselineObservedAt = requireCanonicalTimestamp(
    predecessors.baselineObservedAt,
    "[predecessor] baseline time",
  );
  const lockRevocationObservedAt = requireCanonicalTimestamp(
    predecessors.lockRevocationObservedAt,
    "[predecessor] lock revocation time",
  );
  requireCondition(
    SHA256_PATTERN.test(predecessors.baselineReceiptSha256) &&
      SHA256_PATTERN.test(
        predecessors.lockRevocationReceiptSha256,
      ) &&
      baselineObservedAt < lockRevocationObservedAt &&
      lockRevocationObservedAt < capturedAt,
    "[predecessor] publish chronology drifted",
  );
  const credential = requireObject(
    receipt.credential,
    "[predecessor] publish credential",
  );
  exactKeys(
    credential,
    ["role", "credentialType", "credentialIdSha256"],
    "[predecessor] publish credential",
  );
  requireCondition(
    credential.role === "publisher" &&
      credential.credentialType ===
        "r2-object-read-write-api-token" &&
      SHA256_PATTERN.test(credential.credentialIdSha256),
    "[predecessor] publisher identity drifted",
  );
  const facts = requireObject(
    receipt.facts,
    "[predecessor] publish facts",
  );
  exactKeys(
    facts,
    [
      "createOnlyWritesVerified",
      "awsS3ObjectLockHeadersUsed",
      "objects",
    ],
    "[predecessor] publish facts",
  );
  requireCondition(
    facts.createOnlyWritesVerified === true &&
      facts.awsS3ObjectLockHeadersUsed === false &&
      Array.isArray(facts.objects) &&
      facts.objects.length === WORM_OBJECTS.length,
    "[predecessor] publish facts are incomplete",
  );
  const objects = normalizePublishedObjects(
    facts.objects,
    target,
    lockRevocationObservedAt,
    capturedAt,
  );
  validatePublishOperations(receipt.providerOperations, objects);
  validateCollectorLimits(receipt.limits, "[predecessor] publish limits");
  requireAllDownstreamFalse(
    receipt.downstreamAuthority,
    "[predecessor] publish downstream authority",
  );
  return {
    accountId,
    ...target,
    publisherCredentialIdSha256: credential.credentialIdSha256,
    baselineObservedAt,
    baselineReceiptSha256: predecessors.baselineReceiptSha256,
    lockRevocationObservedAt,
    lockRevocationReceiptSha256:
      predecessors.lockRevocationReceiptSha256,
    publishCapturedAt: capturedAt,
    publishReceiptSha256: sha256Text(receiptText),
    objects,
  };
}

export function normalizeEnforcementPredecessors(options) {
  const publishTarget = normalizeReadbackPredecessor({
    accountId: options.accountId,
    publishReceipt: options.publishReceipt,
    publishReceiptText: options.publishReceiptText,
  });
  const lockRevocationText = requireCanonicalReceipt(
    options.lockRevocationReceipt,
    options.lockRevocationReceiptText,
    "lock revocation receipt",
  );
  const lockRevocation = normalizeLockRevocationReceipt(
    options.lockRevocationReceipt,
    publishTarget.accountId,
  );
  requireSameTarget(
    publishTarget,
    lockRevocation,
    "lock revocation/readback",
  );
  requireCondition(
    sha256Text(lockRevocationText) ===
        publishTarget.lockRevocationReceiptSha256 &&
      lockRevocation.capturedAt ===
        publishTarget.lockRevocationObservedAt,
    "[predecessor] lock revocation receipt digest drifted",
  );
  const receiptText = requireCanonicalReceipt(
    options.readbackReceipt,
    options.readbackReceiptText,
    "readback receipt",
  );
  const receipt = requireObject(
    options.readbackReceipt,
    "[predecessor] readback receipt",
  );
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "contract",
      "source",
      "environment",
      "phase",
      "mode",
      "ok",
      "capturedAt",
      "networkRequests",
      "credentialsRead",
      "writesFiles",
      "providerMutationConfirmed",
      "providerMutationPerformed",
      "target",
      "predecessors",
      "credential",
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    "[predecessor] readback receipt",
  );
  requireCondition(
    receipt.schemaVersion === WORM_DATA_SCHEMA_VERSION &&
      receipt.contract === WORM_DATA_RECEIPT_CONTRACT &&
      receipt.source ===
        "cinatoken-container-runtime-worm-data-collector" &&
      receipt.environment === "staging" &&
      receipt.phase === "readback" &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === true &&
      receipt.providerMutationConfirmed === false &&
      receipt.providerMutationPerformed === false,
    "[predecessor] readback authority is invalid",
  );
  exactKeys(
    receipt.target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "statementSha256",
    ],
    "[predecessor] readback target",
  );
  const target = normalizePublicTarget(
    receipt.target,
    publishTarget.accountId,
  );
  requireSameTarget(
    publishTarget,
    target,
    "publish/readback",
  );
  const capturedAt = requireCanonicalTimestamp(
    receipt.capturedAt,
    "[predecessor] readback capture time",
  );
  const predecessors = requireObject(
    receipt.predecessors,
    "[predecessor] readback predecessors",
  );
  exactKeys(
    predecessors,
    [
      "baselineReceiptSha256",
      "lockRevocationReceiptSha256",
      "publishReceiptSha256",
    ],
    "[predecessor] readback predecessors",
  );
  requireCondition(
    predecessors.baselineReceiptSha256 ===
        publishTarget.baselineReceiptSha256 &&
      predecessors.lockRevocationReceiptSha256 ===
        publishTarget.lockRevocationReceiptSha256 &&
      predecessors.publishReceiptSha256 ===
        publishTarget.publishReceiptSha256,
    "[predecessor] readback receipt chain drifted",
  );
  const credential = requireObject(
    receipt.credential,
    "[predecessor] readback credential",
  );
  exactKeys(
    credential,
    ["role", "credentialType", "credentialIdSha256"],
    "[predecessor] readback credential",
  );
  requireCondition(
    credential.role === "object-verifier" &&
      credential.credentialType === "r2-object-read-api-token" &&
      SHA256_PATTERN.test(credential.credentialIdSha256) &&
      credential.credentialIdSha256 !==
        publishTarget.publisherCredentialIdSha256,
    "[predecessor] object verifier identity drifted",
  );
  const facts = requireObject(
    receipt.facts,
    "[predecessor] readback facts",
  );
  exactKeys(
    facts,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "baselineObservedAt",
      "baselinePaginationComplete",
      "preexistingObjectCount",
      "multipartUploadCount",
      "unknownObjectCount",
      "finalPaginationComplete",
      "createOnlyWritesVerified",
      "awsS3ObjectLockHeadersUsed",
      "objects",
    ],
    "[predecessor] readback facts",
  );
  requireCondition(
    facts.accountIdSha256 === target.accountIdSha256 &&
      facts.bucketName === target.bucketName &&
      facts.jurisdiction === target.jurisdiction &&
      facts.prefix === target.prefix &&
      facts.baselineObservedAt ===
        publishTarget.baselineObservedAt &&
      facts.baselinePaginationComplete === true &&
      facts.preexistingObjectCount === 0 &&
      facts.multipartUploadCount === 0 &&
      facts.unknownObjectCount === 0 &&
      facts.finalPaginationComplete === true &&
      facts.createOnlyWritesVerified === true &&
      facts.awsS3ObjectLockHeadersUsed === false &&
      Array.isArray(facts.objects) &&
      facts.objects.length === WORM_OBJECTS.length,
    "[predecessor] readback facts are incomplete",
  );
  const objects = normalizeReadbackObjects(
    facts.objects,
    publishTarget.objects,
    capturedAt,
  );
  validateReadbackOperations(receipt.providerOperations, objects);
  validateCollectorLimits(
    receipt.limits,
    "[predecessor] readback limits",
  );
  requireAllDownstreamFalse(
    receipt.downstreamAuthority,
    "[predecessor] readback downstream authority",
  );
  requireCondition(
    publishTarget.publishCapturedAt < objects[0].readBackAt &&
      new Set([
        publishTarget.publisherCredentialIdSha256,
        lockRevocation.targetCredentialIdSha256,
        credential.credentialIdSha256,
        lockRevocation.lifecycleOperatorCredentialIdSha256,
        lockRevocation.lifecycleVerifierCredentialIdSha256,
      ]).size === 5,
    "[predecessor] B4 chronology or authority separation drifted",
  );
  return {
    ...publishTarget,
    lockOperatorCredentialIdSha256:
      lockRevocation.targetCredentialIdSha256,
    lockReceiptSha256: lockRevocation.lockReceiptSha256,
    lifecycleOperatorCredentialIdSha256:
      lockRevocation.lifecycleOperatorCredentialIdSha256,
    lifecycleVerifierCredentialIdSha256:
      lockRevocation.lifecycleVerifierCredentialIdSha256,
    objectVerifierCredentialIdSha256:
      credential.credentialIdSha256,
    objectReadbackCapturedAt: capturedAt,
    objectReadbackReceiptSha256: sha256Text(receiptText),
    objects,
  };
}

export async function collectIndependentReadback(options) {
  const {
    target,
    credentials,
    s3,
    sink,
    now = () => new Date(),
  } = options;
  requireCondition(
    s3 &&
      typeof s3.listObjectsV2 === "function" &&
      typeof s3.listMultipartUploads === "function" &&
      typeof s3.getObject === "function",
    "[readback] S3 adapter is incomplete",
  );
  requireCondition(
    sink && typeof sink.beginObject === "function",
    "[readback] output sink is incomplete",
  );
  requireCondition(
    credentials.credentialIdSha256 !==
      target.publisherCredentialIdSha256,
    "[readback] object verifier must differ from the publisher",
  );
  const objectInventory = await collectObjectPages(target, s3);
  const multipartInventory = await collectMultipartPages(target, s3);
  const expectedByKey = new Map(
    target.objects.map((value) => [value.key, value]),
  );
  requireCondition(
    objectInventory.items.length === WORM_OBJECTS.length,
    "[readback] object inventory count drifted",
  );
  const seenKeys = new Set();
  for (const item of objectInventory.items) {
    const expected = expectedByKey.get(item.key);
    requireCondition(
      expected !== undefined &&
        !seenKeys.has(item.key) &&
        item.bytes === expected.bytes &&
        item.etag === expected.etag,
      "[readback] listed object identity drifted",
    );
    seenKeys.add(item.key);
  }
  requireCondition(
    seenKeys.size === expectedByKey.size &&
      multipartInventory.itemCount === 0,
    "[readback] inventory is incomplete or has multipart uploads",
  );
  const records = [];
  const getOperations = [];
  let previousReadBackAt = target.publishCapturedAt;
  for (const object of target.objects) {
    const result = await readOneObject({
      target,
      object,
      s3,
      sink,
      now,
    });
    requireCondition(
      previousReadBackAt <= result.record.readBackAt,
      "[readback] object readback clock moved backwards",
    );
    previousReadBackAt = result.record.readBackAt;
    records.push(result.record);
    getOperations.push(result.operation);
  }
  const capturedAt = records.at(-1).readBackAt;
  const receipt = {
    schemaVersion: WORM_DATA_SCHEMA_VERSION,
    contract: WORM_DATA_RECEIPT_CONTRACT,
    source: "cinatoken-container-runtime-worm-data-collector",
    environment: "staging",
    phase: "readback",
    mode: "live",
    ok: true,
    capturedAt,
    networkRequests: true,
    credentialsRead: true,
    writesFiles: true,
    providerMutationConfirmed: false,
    providerMutationPerformed: false,
    target: publicTarget(target),
    predecessors: {
      baselineReceiptSha256: target.baselineReceiptSha256,
      lockRevocationReceiptSha256:
        target.lockRevocationReceiptSha256,
      publishReceiptSha256: target.publishReceiptSha256,
    },
    credential: {
      role: "object-verifier",
      credentialType: "r2-object-read-api-token",
      credentialIdSha256: credentials.credentialIdSha256,
    },
    facts: {
      accountIdSha256: target.accountIdSha256,
      bucketName: target.bucketName,
      jurisdiction: target.jurisdiction,
      prefix: target.prefix,
      baselineObservedAt: target.baselineObservedAt,
      baselinePaginationComplete: true,
      preexistingObjectCount: 0,
      multipartUploadCount: 0,
      unknownObjectCount: 0,
      finalPaginationComplete: true,
      createOnlyWritesVerified: true,
      awsS3ObjectLockHeadersUsed: false,
      objects: records,
    },
    providerOperations: [
      ...objectInventory.operations,
      ...multipartInventory.operations,
      ...getOperations,
    ],
    limits: collectorLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
  assertSensitiveValuesAbsent(receipt, [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    target.accountId,
  ]);
  return receipt;
}

async function readOneObject(options) {
  const { target, object, s3, sink, now } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let writer = null;
  try {
    let response;
    try {
      response = await s3.getObject(
        {
          Bucket: target.bucketName,
          Key: object.key,
          IfMatch: object.etag,
        },
        controller.signal,
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new WormDataCollectorError(
          `[readback] ${object.kind} request timed out`,
        );
      }
      throw new WormDataCollectorError(
        `[readback] ${object.kind} provider request failed`,
      );
    }
    response = requireObject(
      response,
      `[readback] ${object.kind} response`,
    );
    const metadata = requireSuccessMetadata(
      response,
      `GetObject ${object.kind}`,
    );
    validateGetObjectHeaders(response, object);
    writer = await sink.beginObject({
      kind: object.kind,
      fileName: object.fileName,
      bytes: object.bytes,
      sha256: object.sha256,
    });
    requireCondition(
      writer &&
        typeof writer.write === "function" &&
        typeof writer.commit === "function" &&
        typeof writer.abort === "function",
      `[readback] ${object.kind} output writer is incomplete`,
    );
    const digest = createHash("sha256");
    let bytes = 0;
    const body = response.Body;
    requireCondition(
      body && typeof body[Symbol.asyncIterator] === "function",
      `[readback] ${object.kind} body is not streamable`,
    );
    for await (const rawChunk of body) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : rawChunk instanceof Uint8Array
          ? Buffer.from(
              rawChunk.buffer,
              rawChunk.byteOffset,
              rawChunk.byteLength,
            )
          : null;
      requireCondition(
        chunk !== null && chunk.length > 0,
        `[readback] ${object.kind} returned an invalid body chunk`,
      );
      bytes += chunk.length;
      requireCondition(
        bytes <= object.bytes && bytes <= MAX_OBJECT_BYTES,
        `[readback] ${object.kind} exceeded its byte bound`,
      );
      digest.update(chunk);
      await writer.write(chunk);
    }
    const sha256 = digest.digest("hex");
    requireCondition(
      bytes === object.bytes && sha256 === object.sha256,
      `[readback] ${object.kind} body digest or size drifted`,
    );
    await writer.commit();
    writer = null;
    const readBackAt = requireTimestamp(
      now(),
      `[readback] ${object.kind} readback time`,
    );
    requireCondition(
      object.uploadedAt < readBackAt,
      `[readback] ${object.kind} readback did not follow upload`,
    );
    return {
      record: {
        kind: object.kind,
        path: `objects/${object.fileName}`,
        key: object.key,
        bytes: object.bytes,
        sha256: object.sha256,
        etag: object.etag,
        contentType: object.contentType,
        uploadedAt: object.uploadedAt,
        uploadHttpStatus: object.uploadHttpStatus,
        uploadRequestId: object.uploadRequestId,
        readBackAt,
        httpStatus: metadata.httpStatus,
        providerRequestId: metadata.providerRequestId,
        customMetadata: object.customMetadata,
      },
      operation: {
        operation: "GetObject",
        kind: object.kind,
        key: object.key,
        httpStatus: metadata.httpStatus,
        providerRequestId: metadata.providerRequestId,
        etag: object.etag,
        bytes,
        sha256,
      },
    };
  } catch (error) {
    if (writer) {
      try {
        await writer.abort();
      } catch {
        // Preserve the original fail-closed error.
      }
    }
    if (error instanceof WormDataCollectorError) throw error;
    throw new WormDataCollectorError(
      `[readback] ${object.kind} collection failed`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function collectObjectPages(target, s3) {
  const items = [];
  const operations = [];
  const seenTokens = new Set();
  let continuationToken;
  let page = 0;
  while (true) {
    page += 1;
    requireCondition(
      page <= MAX_LIST_PAGES,
      "[readback] object pagination exceeded its page bound",
    );
    const response = await invokeAdapter(
      (abortSignal) =>
        s3.listObjectsV2(
          {
            Bucket: target.bucketName,
            Prefix: target.prefix,
            MaxKeys: 1_000,
            ContinuationToken: continuationToken,
          },
          abortSignal,
        ),
      `ListObjectsV2 page ${page}`,
    );
    const metadata = requireSuccessMetadata(
      response,
      `ListObjectsV2 page ${page}`,
    );
    requireCondition(
      response.Name === target.bucketName &&
        response.Prefix === target.prefix,
      "[readback] listing target drifted",
    );
    const contents = optionalArray(
      response.Contents,
      "[readback] object contents",
    );
    const commonPrefixes = optionalArray(
      response.CommonPrefixes,
      "[readback] common prefixes",
    );
    requireCondition(
      commonPrefixes.length === 0 && contents.length <= 1_000,
      "[readback] object page is ambiguous",
    );
    for (const raw of contents) {
      const item = requireObject(raw, "[readback] listed object");
      requireCondition(
        typeof item.Key === "string" &&
          item.Key.startsWith(target.prefix) &&
          Number.isSafeInteger(item.Size) &&
          item.Size > 0 &&
          item.Size <= MAX_OBJECT_BYTES &&
          typeof item.ETag === "string" &&
          E_TAG_PATTERN.test(item.ETag),
        "[readback] listed object is invalid",
      );
      items.push({
        key: item.Key,
        bytes: item.Size,
        etag: item.ETag,
      });
    }
    requireCondition(
      items.length <= MAX_LIST_ITEMS,
      "[readback] object inventory exceeded its item bound",
    );
    if (response.KeyCount !== undefined) {
      requireCondition(
        Number.isSafeInteger(response.KeyCount) &&
          response.KeyCount === contents.length,
        "[readback] object KeyCount drifted",
      );
    }
    operations.push({
      operation: "ListObjectsV2",
      page,
      httpStatus: metadata.httpStatus,
      providerRequestId: metadata.providerRequestId,
    });
    const truncated = requireBoolean(
      response.IsTruncated,
      "[readback] object IsTruncated",
    );
    const next = optionalString(response.NextContinuationToken);
    if (!truncated) {
      requireCondition(
        next === null,
        "[readback] completed listing returned a continuation token",
      );
      break;
    }
    requireCondition(
      next !== null && !seenTokens.has(next),
      "[readback] object continuation token repeated",
    );
    seenTokens.add(next);
    continuationToken = next;
  }
  return { items, operations };
}

async function collectMultipartPages(target, s3) {
  const operations = [];
  const seenMarkers = new Set();
  let keyMarker;
  let uploadIdMarker;
  let page = 0;
  let itemCount = 0;
  while (true) {
    page += 1;
    requireCondition(
      page <= MAX_LIST_PAGES,
      "[readback] multipart pagination exceeded its page bound",
    );
    const response = await invokeAdapter(
      (abortSignal) =>
        s3.listMultipartUploads(
          {
            Bucket: target.bucketName,
            Prefix: target.prefix,
            MaxUploads: 1_000,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          },
          abortSignal,
        ),
      `ListMultipartUploads page ${page}`,
    );
    const metadata = requireSuccessMetadata(
      response,
      `ListMultipartUploads page ${page}`,
    );
    requireCondition(
      response.Bucket === target.bucketName &&
        response.Prefix === target.prefix,
      "[readback] multipart listing target drifted",
    );
    const uploads = optionalArray(
      response.Uploads,
      "[readback] multipart uploads",
    );
    for (const raw of uploads) {
      const upload = requireObject(
        raw,
        "[readback] multipart upload",
      );
      requireCondition(
        typeof upload.Key === "string" &&
          upload.Key.startsWith(target.prefix) &&
          typeof upload.UploadId === "string" &&
          upload.UploadId.length > 0,
        "[readback] multipart upload escaped the prefix",
      );
    }
    itemCount += uploads.length;
    requireCondition(
      itemCount <= MAX_MULTIPART_UPLOADS,
      "[readback] multipart inventory exceeded its bound",
    );
    operations.push({
      operation: "ListMultipartUploads",
      page,
      httpStatus: metadata.httpStatus,
      providerRequestId: metadata.providerRequestId,
    });
    const truncated = requireBoolean(
      response.IsTruncated,
      "[readback] multipart IsTruncated",
    );
    const nextKey = optionalString(response.NextKeyMarker);
    const nextUpload = optionalString(response.NextUploadIdMarker);
    if (!truncated) {
      requireCondition(
        nextKey === null && nextUpload === null,
        "[readback] completed multipart listing returned markers",
      );
      break;
    }
    requireCondition(
      nextKey !== null && nextUpload !== null,
      "[readback] multipart continuation markers are incomplete",
    );
    const marker = `${nextKey}\n${nextUpload}`;
    requireCondition(
      !seenMarkers.has(marker),
      "[readback] multipart continuation markers repeated",
    );
    seenMarkers.add(marker);
    keyMarker = nextKey;
    uploadIdMarker = nextUpload;
  }
  return { itemCount, operations };
}

function normalizeBaselineReceipt(receipt, accountId) {
  receipt = requireObject(receipt, "[predecessor] baseline receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "contract",
      "source",
      "environment",
      "phase",
      "mode",
      "ok",
      "capturedAt",
      "networkRequests",
      "credentialsRead",
      "writesFiles",
      "phaseMutationConfirmed",
      "mutationPerformed",
      "target",
      "credential",
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    "[predecessor] baseline receipt",
  );
  requireCondition(
    receipt.schemaVersion === WORM_STAGING_SCHEMA_VERSION &&
      receipt.contract === WORM_STAGING_RECEIPT_CONTRACT &&
      receipt.source ===
        "cinatoken-container-runtime-worm-staging-collector" &&
      receipt.environment === "staging" &&
      receipt.phase === "baseline" &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === false &&
      receipt.phaseMutationConfirmed === false &&
      receipt.mutationPerformed === false,
    "[predecessor] baseline authority is invalid",
  );
  exactKeys(
    receipt.target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "statementSha256",
    ],
    "[predecessor] baseline target",
  );
  const target = normalizePublicTarget(receipt.target, accountId);
  const capturedAt = requireCanonicalTimestamp(
    receipt.capturedAt,
    "[predecessor] baseline time",
  );
  const credential = requireObject(
    receipt.credential,
    "[predecessor] baseline credential",
  );
  exactKeys(
    credential,
    ["role", "credentialType", "credentialIdSha256"],
    "[predecessor] baseline credential",
  );
  requireCondition(
    credential.role === "publisher" &&
      credential.credentialType ===
        "r2-object-read-write-api-token" &&
      SHA256_PATTERN.test(credential.credentialIdSha256),
    "[predecessor] baseline publisher identity drifted",
  );
  const facts = requireObject(
    receipt.facts,
    "[predecessor] baseline facts",
  );
  exactKeys(
    facts,
    [
      "baselineObservedAt",
      "baselinePaginationComplete",
      "preexistingObjectCount",
      "multipartUploadCount",
      "objectPages",
      "multipartPages",
      "providerRequestIdsComplete",
    ],
    "[predecessor] baseline facts",
  );
  requireCondition(
    facts.baselineObservedAt === capturedAt &&
      facts.baselinePaginationComplete === true &&
      facts.preexistingObjectCount === 0 &&
      facts.multipartUploadCount === 0 &&
      Number.isSafeInteger(facts.objectPages) &&
      facts.objectPages > 0 &&
      facts.objectPages <= MAX_LIST_PAGES &&
      Number.isSafeInteger(facts.multipartPages) &&
      facts.multipartPages > 0 &&
      facts.multipartPages <= MAX_LIST_PAGES &&
      facts.providerRequestIdsComplete === true,
    "[predecessor] baseline facts are incomplete",
  );
  validateBaselineOperations(receipt.providerOperations, facts);
  validateStagingLimits(receipt.limits);
  requireAllDownstreamFalse(
    receipt.downstreamAuthority,
    "[predecessor] baseline downstream authority",
  );
  return {
    ...target,
    capturedAt,
    publisherCredentialIdSha256: credential.credentialIdSha256,
  };
}

function normalizeLockRevocationReceipt(receipt, accountId) {
  receipt = requireObject(
    receipt,
    "[predecessor] lock revocation receipt",
  );
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "contract",
      "source",
      "environment",
      "phase",
      "mode",
      "ok",
      "capturedAt",
      "networkRequests",
      "credentialsRead",
      "writesFiles",
      "phaseMutationConfirmed",
      "mutationPerformed",
      "target",
      "authority",
      "facts",
      "providerOperations",
      "limits",
      "downstreamAuthority",
    ],
    "[predecessor] lock revocation receipt",
  );
  requireCondition(
    receipt.schemaVersion === WORM_LIFECYCLE_SCHEMA_VERSION &&
      receipt.contract === WORM_LIFECYCLE_RECEIPT_CONTRACT &&
      receipt.source ===
        "cinatoken-container-runtime-worm-lifecycle-collector" &&
      receipt.environment === "staging" &&
      receipt.phase === "verify" &&
      receipt.mode === "live" &&
      receipt.ok === true &&
      receipt.networkRequests === true &&
      receipt.credentialsRead === true &&
      receipt.writesFiles === false &&
      receipt.phaseMutationConfirmed === false &&
      receipt.mutationPerformed === false,
    "[predecessor] lock revocation authority is invalid",
  );
  const target = requireObject(
    receipt.target,
    "[predecessor] lock revocation target",
  );
  exactKeys(
    target,
    [
      "accountIdSha256",
      "bucketName",
      "jurisdiction",
      "prefix",
      "statementSha256",
      "targetRole",
      "targetCredentialIdSha256",
      "lockReceiptSha256",
      "lockCapturedAt",
      "revokeReceiptSha256",
      "revokeCapturedAt",
      "lifecycleOperatorCredentialIdSha256",
      "operatorReadbackErrorCodes",
    ],
    "[predecessor] lock revocation target",
  );
  const normalizedTarget = normalizePublicTarget(target, accountId);
  const lockCapturedAt = requireCanonicalTimestamp(
    target.lockCapturedAt,
    "[predecessor] lock capture time",
  );
  const revokeCapturedAt = requireCanonicalTimestamp(
    target.revokeCapturedAt,
    "[predecessor] revoke capture time",
  );
  requireCondition(
    target.targetRole === "lock-operator" &&
      SHA256_PATTERN.test(target.targetCredentialIdSha256) &&
      SHA256_PATTERN.test(target.lockReceiptSha256) &&
      SHA256_PATTERN.test(target.revokeReceiptSha256) &&
      SHA256_PATTERN.test(
        target.lifecycleOperatorCredentialIdSha256,
      ) &&
      validErrorCodes(target.operatorReadbackErrorCodes),
    "[predecessor] lock revocation target drifted",
  );
  const authority = normalizeLifecycleAuthority(
    receipt.authority,
    "lifecycle-verifier",
    "cloudflare-account-api-token-read",
  );
  const facts = requireObject(
    receipt.facts,
    "[predecessor] lock revocation facts",
  );
  exactKeys(
    facts,
    [
      "apiSurface",
      "independentReadbackAt",
      "independentReadbackErrorCodes",
      "independentReadbackHttpStatus",
      "independentReadbackRequestId",
      "independentReadbackResponseBodySha256",
      "operatorAndVerifierCredentialIdsDistinct",
      "targetAbsenceIndependentlyObserved",
    ],
    "[predecessor] lock revocation facts",
  );
  const capturedAt = requireCanonicalTimestamp(
    receipt.capturedAt,
    "[predecessor] independent readback time",
  );
  requireCondition(
    facts.apiSurface === "cloudflare-account-token-api" &&
      facts.independentReadbackAt === capturedAt &&
      facts.independentReadbackHttpStatus === 404 &&
      validProviderId(
        facts.independentReadbackRequestId,
      ) &&
      SHA256_PATTERN.test(
        facts.independentReadbackResponseBodySha256,
      ) &&
      validErrorCodes(facts.independentReadbackErrorCodes) &&
      canonicalJson(facts.independentReadbackErrorCodes) ===
        canonicalJson(target.operatorReadbackErrorCodes) &&
      facts.operatorAndVerifierCredentialIdsDistinct === true &&
      facts.targetAbsenceIndependentlyObserved === true &&
      authority.credentialIdSha256 !==
        target.targetCredentialIdSha256 &&
      authority.credentialIdSha256 !==
        target.lifecycleOperatorCredentialIdSha256 &&
      lockCapturedAt < revokeCapturedAt &&
      revokeCapturedAt < authority.selfVerifiedAt &&
      authority.selfVerifiedAt < capturedAt &&
      capturedAt < authority.expiresAt,
    "[predecessor] lock revocation facts are invalid",
  );
  requireCondition(
    Array.isArray(receipt.providerOperations) &&
      receipt.providerOperations.length === 2,
    "[predecessor] lock revocation operations are incomplete",
  );
  requireLifecycleOperation(
    receipt.providerOperations[0],
    "lifecycle-verifier-preflight",
    200,
  );
  requireLifecycleOperation(
    receipt.providerOperations[1],
    "independent-revocation-readback",
    404,
  );
  requireCondition(
    receipt.providerOperations[0].providerRequestId !==
        receipt.providerOperations[1].providerRequestId &&
      receipt.providerOperations[1].providerRequestId ===
        facts.independentReadbackRequestId &&
      receipt.providerOperations[1].responseBodySha256 ===
        facts.independentReadbackResponseBodySha256,
    "[predecessor] lock revocation provider correlation drifted",
  );
  validateLifecycleLimits(receipt.limits);
  requireAllDownstreamFalse(
    receipt.downstreamAuthority,
    "[predecessor] lock revocation downstream authority",
  );
  return {
    ...normalizedTarget,
    targetCredentialIdSha256: target.targetCredentialIdSha256,
    lockReceiptSha256: target.lockReceiptSha256,
    lifecycleOperatorCredentialIdSha256:
      target.lifecycleOperatorCredentialIdSha256,
    lifecycleVerifierCredentialIdSha256:
      authority.credentialIdSha256,
    lockCapturedAt,
    revokeCapturedAt,
    verifierSelfVerifiedAt: authority.selfVerifiedAt,
    capturedAt,
  };
}

function normalizePublicTarget(value, accountId) {
  const target = requireObject(value, "[predecessor] target");
  for (const key of [
    "accountIdSha256",
    "bucketName",
    "jurisdiction",
    "prefix",
    "statementSha256",
  ]) {
    requireCondition(
      Object.hasOwn(target, key),
      `[predecessor] target is missing ${key}`,
    );
  }
  requireCondition(
    target.accountIdSha256 === sha256Text(accountId) &&
      typeof target.bucketName === "string" &&
      BUCKET_NAME_PATTERN.test(target.bucketName) &&
      typeof target.jurisdiction === "string" &&
      ["default", "eu", "fedramp"].includes(target.jurisdiction) &&
      SHA256_PATTERN.test(target.statementSha256) &&
      target.prefix ===
        `container-runtime/s3/v1/${target.statementSha256}/`,
    "[predecessor] target drifted",
  );
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
  };
}

function normalizePublishedObjects(
  values,
  target,
  lockRevocationObservedAt,
  capturedAt,
) {
  const objects = [];
  let totalBytes = 0;
  for (let index = 0; index < WORM_OBJECTS.length; index += 1) {
    const expected = WORM_OBJECTS[index];
    const object = requireObject(
      values[index],
      `[predecessor] ${expected.kind}`,
    );
    exactKeys(
      object,
      [
        "kind",
        "fileName",
        "key",
        "bytes",
        "sha256",
        "etag",
        "contentType",
        "uploadedAt",
        "uploadHttpStatus",
        "uploadRequestId",
        "customMetadata",
      ],
      `[predecessor] ${expected.kind}`,
    );
    const uploadedAt = requireCanonicalTimestamp(
      object.uploadedAt,
      `[predecessor] ${expected.kind} upload time`,
    );
    const metadata = requireObject(
      object.customMetadata,
      `[predecessor] ${expected.kind} metadata`,
    );
    exactKeys(
      metadata,
      ["contract", "repositoryCommit", "sha256"],
      `[predecessor] ${expected.kind} metadata`,
    );
    requireCondition(
      object.kind === expected.kind &&
        object.fileName === expected.fileName &&
        object.key === `${target.prefix}${expected.fileName}` &&
        Number.isSafeInteger(object.bytes) &&
        object.bytes > 0 &&
        object.bytes <= MAX_OBJECT_BYTES &&
        SHA256_PATTERN.test(object.sha256) &&
        typeof object.etag === "string" &&
        E_TAG_PATTERN.test(object.etag) &&
        object.contentType === expected.contentType &&
        object.uploadHttpStatus === 200 &&
        validProviderId(object.uploadRequestId) &&
        metadata.contract === MANIFEST_CONTRACT &&
        COMMIT_SHA_PATTERN.test(metadata.repositoryCommit) &&
        metadata.sha256 === object.sha256 &&
        lockRevocationObservedAt < uploadedAt &&
        uploadedAt <= capturedAt,
      `[predecessor] ${expected.kind} upload drifted`,
    );
    if (expected.kind === "provenance-statement") {
      requireCondition(
        object.sha256 === target.statementSha256,
        "[predecessor] statement digest drifted",
      );
    }
    totalBytes += object.bytes;
    requireCondition(
      totalBytes <= MAX_TOTAL_OBJECT_BYTES,
      "[predecessor] published object aggregate exceeded",
    );
    objects.push({ ...object, uploadedAt });
  }
  return objects;
}

function normalizeReadbackObjects(values, published, capturedAt) {
  const objects = [];
  let previousReadBackAt = null;
  for (let index = 0; index < published.length; index += 1) {
    const expected = published[index];
    const object = requireObject(
      values[index],
      `[predecessor] ${expected.kind} readback`,
    );
    exactKeys(
      object,
      [
        "kind",
        "path",
        "key",
        "bytes",
        "sha256",
        "etag",
        "contentType",
        "uploadedAt",
        "uploadHttpStatus",
        "uploadRequestId",
        "readBackAt",
        "httpStatus",
        "providerRequestId",
        "customMetadata",
      ],
      `[predecessor] ${expected.kind} readback`,
    );
    const readBackAt = requireCanonicalTimestamp(
      object.readBackAt,
      `[predecessor] ${expected.kind} readback time`,
    );
    requireCondition(
      object.kind === expected.kind &&
        object.path === `objects/${expected.fileName}` &&
        object.key === expected.key &&
        object.bytes === expected.bytes &&
        object.sha256 === expected.sha256 &&
        object.etag === expected.etag &&
        object.contentType === expected.contentType &&
        object.uploadedAt === expected.uploadedAt &&
        object.uploadHttpStatus === expected.uploadHttpStatus &&
        object.uploadRequestId === expected.uploadRequestId &&
        object.httpStatus === 200 &&
        validProviderId(object.providerRequestId) &&
        canonicalJson(object.customMetadata) ===
          canonicalJson(expected.customMetadata) &&
        expected.uploadedAt < readBackAt &&
        (previousReadBackAt === null ||
          previousReadBackAt <= readBackAt) &&
        readBackAt <= capturedAt,
      `[predecessor] ${expected.kind} readback drifted`,
    );
    previousReadBackAt = readBackAt;
    objects.push({ ...object, readBackAt });
  }
  requireCondition(
    previousReadBackAt === capturedAt,
    "[predecessor] readback capture does not match the final object",
  );
  return objects;
}

function validateReadbackOperations(values, objects) {
  requireCondition(
    Array.isArray(values) && values.length >= objects.length + 2,
    "[predecessor] readback operations are incomplete",
  );
  const requestIds = new Set();
  let index = 0;
  index = validatePagedReadbackOperations(
    values,
    index,
    "ListObjectsV2",
    requestIds,
  );
  index = validatePagedReadbackOperations(
    values,
    index,
    "ListMultipartUploads",
    requestIds,
  );
  requireCondition(
    values.length - index === objects.length,
    "[predecessor] readback GET operation count drifted",
  );
  for (const object of objects) {
    const operation = requireObject(
      values[index],
      "[predecessor] readback GET operation",
    );
    exactKeys(
      operation,
      [
        "operation",
        "kind",
        "key",
        "httpStatus",
        "providerRequestId",
        "etag",
        "bytes",
        "sha256",
      ],
      "[predecessor] readback GET operation",
    );
    requireCondition(
      operation.operation === "GetObject" &&
        operation.kind === object.kind &&
        operation.key === object.key &&
        operation.httpStatus === 200 &&
        operation.providerRequestId === object.providerRequestId &&
        operation.etag === object.etag &&
        operation.bytes === object.bytes &&
        operation.sha256 === object.sha256 &&
        !requestIds.has(operation.providerRequestId),
      "[predecessor] readback GET operation drifted",
    );
    requestIds.add(operation.providerRequestId);
    index += 1;
  }
}

function validatePagedReadbackOperations(
  values,
  start,
  operationName,
  requestIds,
) {
  let index = start;
  let page = 1;
  while (
    index < values.length &&
    values[index]?.operation === operationName
  ) {
    const operation = requireObject(
      values[index],
      `[predecessor] ${operationName} operation`,
    );
    exactKeys(
      operation,
      [
        "operation",
        "page",
        "httpStatus",
        "providerRequestId",
      ],
      `[predecessor] ${operationName} operation`,
    );
    requireCondition(
      operation.page === page &&
        page <= MAX_LIST_PAGES &&
        operation.httpStatus === 200 &&
        validProviderId(operation.providerRequestId) &&
        !requestIds.has(operation.providerRequestId),
      `[predecessor] ${operationName} operation drifted`,
    );
    requestIds.add(operation.providerRequestId);
    index += 1;
    page += 1;
  }
  requireCondition(
    page > 1,
    `[predecessor] ${operationName} operation is absent`,
  );
  return index;
}

function validatePublishOperations(values, objects) {
  requireCondition(
    Array.isArray(values) && values.length === objects.length,
    "[predecessor] publish operations are incomplete",
  );
  for (let index = 0; index < objects.length; index += 1) {
    const operation = requireObject(
      values[index],
      "[predecessor] publish operation",
    );
    exactKeys(
      operation,
      [
        "operation",
        "condition",
        "kind",
        "key",
        "httpStatus",
        "providerRequestId",
        "etag",
      ],
      "[predecessor] publish operation",
    );
    const object = objects[index];
    requireCondition(
      operation.operation === "PutObject" &&
        operation.condition === "If-None-Match:*" &&
        operation.kind === object.kind &&
        operation.key === object.key &&
        operation.httpStatus === object.uploadHttpStatus &&
        operation.providerRequestId === object.uploadRequestId &&
        operation.etag === object.etag,
      "[predecessor] publish operation drifted",
    );
  }
}

function validateGetObjectHeaders(response, object) {
  const metadata = requireObject(
    response.Metadata,
    `[readback] ${object.kind} metadata`,
  );
  exactKeys(
    metadata,
    ["contract", "repositorycommit", "sha256"],
    `[readback] ${object.kind} metadata`,
  );
  requireCondition(
    response.ContentLength === object.bytes &&
      response.ContentType === object.contentType &&
      response.ETag === object.etag &&
      metadata.contract === MANIFEST_CONTRACT &&
      metadata.repositorycommit ===
        object.customMetadata.repositoryCommit &&
      metadata.sha256 === object.sha256,
    `[readback] ${object.kind} headers or metadata drifted`,
  );
}

function normalizeLifecycleAuthority(value, role, credentialType) {
  const authority = requireObject(
    value,
    "[predecessor] lifecycle authority",
  );
  exactKeys(
    authority,
    [
      "role",
      "credentialType",
      "credentialIdSha256",
      "selfVerifiedAt",
      "expiresAt",
      "remainingLifetimeSeconds",
    ],
    "[predecessor] lifecycle authority",
  );
  const selfVerifiedAt = requireCanonicalTimestamp(
    authority.selfVerifiedAt,
    "[predecessor] lifecycle verification time",
  );
  const expiresAt = requireCanonicalTimestamp(
    authority.expiresAt,
    "[predecessor] lifecycle expiry",
  );
  const remainingMs = Date.parse(expiresAt) - Date.parse(selfVerifiedAt);
  requireCondition(
    authority.role === role &&
      authority.credentialType === credentialType &&
      SHA256_PATTERN.test(authority.credentialIdSha256) &&
      remainingMs >= 1_000 &&
      remainingMs <= 3_600_000 &&
      authority.remainingLifetimeSeconds ===
        Math.floor(remainingMs / 1_000),
    "[predecessor] lifecycle authority drifted",
  );
  return {
    ...authority,
    selfVerifiedAt,
    expiresAt,
  };
}

function requireLifecycleOperation(value, operation, status) {
  value = requireObject(value, "[predecessor] lifecycle operation");
  exactKeys(
    value,
    [
      "method",
      "operation",
      "httpStatus",
      "providerRequestId",
      "responseBodySha256",
    ],
    "[predecessor] lifecycle operation",
  );
  requireCondition(
    value.method === "GET" &&
      value.operation === operation &&
      value.httpStatus === status &&
      validProviderId(value.providerRequestId) &&
      SHA256_PATTERN.test(value.responseBodySha256),
    "[predecessor] lifecycle operation drifted",
  );
}

function validateLifecycleLimits(value) {
  value = requireObject(value, "[predecessor] lifecycle limits");
  exactKeys(
    value,
    [
      "requestTimeoutMs",
      "responseBytes",
      "predecessorReceiptBytes",
      "mutableCredentialRemainingSeconds",
    ],
    "[predecessor] lifecycle limits",
  );
  requireCondition(
    value.requestTimeoutMs === 30_000 &&
      value.responseBytes === 1024 * 1024 &&
      value.predecessorReceiptBytes === 1024 * 1024 &&
      value.mutableCredentialRemainingSeconds === 3_600,
    "[predecessor] lifecycle limits drifted",
  );
}

function validateStagingLimits(value) {
  value = requireObject(value, "[predecessor] staging limits");
  exactKeys(
    value,
    [
      "requestTimeoutMs",
      "responseBytes",
      "mutableCredentialRemainingSeconds",
      "listPages",
      "listItems",
      "lockRules",
    ],
    "[predecessor] staging limits",
  );
  requireCondition(
    value.requestTimeoutMs === 30_000 &&
      value.responseBytes === 1024 * 1024 &&
      value.mutableCredentialRemainingSeconds === 3_600 &&
      value.listPages === 1_000 &&
      value.listItems === 10_000 &&
      value.lockRules === 1_000,
    "[predecessor] staging limits drifted",
  );
}

function validateCollectorLimits(value, label) {
  value = requireObject(value, label);
  const expected = collectorLimits();
  requireCondition(
    canonicalJson(value) === canonicalJson(expected),
    `${label} drifted`,
  );
}

function validateBaselineOperations(values, facts) {
  requireCondition(
    Array.isArray(values) &&
      values.length === facts.objectPages + facts.multipartPages,
    "[predecessor] baseline operations are incomplete",
  );
  const requestIds = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = requireObject(
      values[index],
      "[predecessor] baseline operation",
    );
    exactKeys(
      value,
      [
        "operation",
        "page",
        "httpStatus",
        "providerRequestId",
      ],
      "[predecessor] baseline operation",
    );
    const objectPage = index < facts.objectPages;
    const expectedPage = objectPage
      ? index + 1
      : index - facts.objectPages + 1;
    requireCondition(
      value.operation ===
          (objectPage ? "ListObjectsV2" : "ListMultipartUploads") &&
        value.page === expectedPage &&
        value.httpStatus === 200 &&
        validProviderId(value.providerRequestId) &&
        !requestIds.has(value.providerRequestId),
      "[predecessor] baseline operation drifted",
    );
    requestIds.add(value.providerRequestId);
  }
}

function requireSameTarget(left, right, label) {
  requireCondition(
    left.accountIdSha256 === right.accountIdSha256 &&
      left.bucketName === right.bucketName &&
      left.jurisdiction === right.jurisdiction &&
      left.prefix === right.prefix &&
      left.statementSha256 === right.statementSha256,
    `[predecessor] ${label} target drifted`,
  );
}

function publicTarget(target) {
  return {
    accountIdSha256: target.accountIdSha256,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    prefix: target.prefix,
    statementSha256: target.statementSha256,
  };
}

async function invokeAdapter(call, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await call(controller.signal);
    return requireObject(response, `[${label}] response`);
  } catch (error) {
    if (error instanceof WormDataCollectorError) throw error;
    if (error?.name === "AbortError") {
      throw new WormDataCollectorError(`[${label}] request timed out`);
    }
    throw new WormDataCollectorError(`[${label}] provider request failed`);
  } finally {
    clearTimeout(timeout);
  }
}

function requireSuccessMetadata(response, label) {
  const metadata = requireObject(response.$metadata, `[${label}] metadata`);
  requireCondition(
    metadata.httpStatusCode === 200 &&
      validProviderId(metadata.requestId),
    `[${label}] provider success metadata is incomplete`,
  );
  return {
    httpStatus: metadata.httpStatusCode,
    providerRequestId: metadata.requestId,
  };
}

function collectorLimits() {
  return {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    predecessorReceiptBytes: MAX_RECEIPT_BYTES,
    objectBytes: MAX_OBJECT_BYTES,
    totalObjectBytes: MAX_TOTAL_OBJECT_BYTES,
    listPages: MAX_LIST_PAGES,
    listItems: MAX_LIST_ITEMS,
    multipartUploads: MAX_MULTIPART_UPLOADS,
  };
}

function downstreamAuthority() {
  return {
    lockOperatorRevocationVerified: false,
    publisherRevocationVerified: false,
    wormRetentionVerified: false,
    s3Complete: false,
    formalP5Evidence: false,
    customerTrafficAuthorized: false,
    productionCutoverAuthorized: false,
  };
}

function requireAllDownstreamFalse(value, label) {
  value = requireObject(value, label);
  requireCondition(
    canonicalJson(value) === canonicalJson(downstreamAuthority()),
    `${label} overclaimed authority`,
  );
}

function assertSensitiveValuesAbsent(value, sensitiveValues) {
  const serialized = canonicalJson(value);
  for (const sensitive of sensitiveValues) {
    if (
      typeof sensitive === "string" &&
      sensitive.length > 0 &&
      serialized.includes(sensitive)
    ) {
      throw new WormDataCollectorError(
        "[redaction] receipt contained sensitive input",
      );
    }
  }
}

function requireCanonicalReceipt(value, text, label) {
  requireCondition(
    typeof text === "string" &&
      Buffer.byteLength(text, "utf8") >= 2 &&
      Buffer.byteLength(text, "utf8") <= MAX_RECEIPT_BYTES &&
      text === `${canonicalJson(value)}\n`,
    `[predecessor] ${label} must be bounded canonical JSON plus one newline`,
  );
  return text;
}

function requireCredential(value, name) {
  requireCondition(
    typeof value === "string" &&
      value.length >= 20 &&
      value.length <= 4096 &&
      !/[^\x21-\x7e]/.test(value),
    `[credentials] ${name} is absent or invalid`,
  );
  return value;
}

function requirePhase(value) {
  requireCondition(
    value === "publish" || value === "readback",
    "[phase] phase must be publish or readback",
  );
}

function requireCanonicalTimestamp(value, label) {
  requireCondition(
    typeof value === "string" &&
      RFC3339_PATTERN.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() ===
        (value.includes(".") ? value : value.replace("Z", ".000Z")),
    `${label} is not a canonical timestamp`,
  );
  return value;
}

function requireTimestamp(value, label) {
  requireCondition(
    value instanceof Date && Number.isFinite(value.getTime()),
    `${label} is invalid`,
  );
  return value.toISOString();
}

function requirePattern(value, pattern, label) {
  requireCondition(typeof value === "string" && pattern.test(value), `${label} is invalid`);
  return value;
}

function requireObject(value, label) {
  requireCondition(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${label} must be an object`,
  );
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(
    canonicalJson(actual) === canonicalJson(wanted),
    `${label} fields drifted`,
  );
}

function optionalArray(value, label) {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value), `${label} must be an array`);
  return value;
}

function optionalString(value) {
  if (value === undefined) return null;
  requireCondition(
    typeof value === "string" && value.length > 0 && value.length <= 4096,
    "[provider] continuation value is invalid",
  );
  return value;
}

function requireBoolean(value, label) {
  requireCondition(typeof value === "boolean", `${label} must be boolean`);
  return value;
}

function validContentMd5(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9+/]{22}==$/.test(value) &&
    Buffer.from(value, "base64").length === 16
  );
}

function validErrorCodes(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(
      (entry) => Number.isSafeInteger(entry) && entry >= 0,
    ) &&
    new Set(value).size === value.length
  );
}

function validProviderId(value) {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new WormDataCollectorError(message);
}
