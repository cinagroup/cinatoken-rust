import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path, {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import {
  normalizePublishPredecessors,
} from "./container_runtime_worm_data.mjs";
import {
  normalizeFinalLockPredecessors,
  normalizeFinalLockReadbackReceipt,
  normalizePostReadbackReceipt,
  normalizeProbePredecessors,
  normalizeProbeReceipt,
  normalizePublisherRevokeReceipt,
  normalizePublisherVerifyReceipt,
} from "./container_runtime_worm_enforcement.mjs";
import {
  normalizeLockPredecessor,
  normalizeRevokePredecessor,
} from "./container_runtime_worm_lifecycle.mjs";
import { readCanonicalReceiptFile } from "./container_runtime_worm_receipt_file.mjs";
import { canonicalJson } from "./container_runtime_worm_staging.mjs";
import {
  ANCHOR_DOMAIN,
  EVIDENCE_CONTRACT,
  MANIFEST_CONTRACT,
  REQUIRED_APPROVAL_ROLES,
  REQUIRED_AUTHORITY_PROFILES,
  REQUIRED_EVIDENCE_KINDS,
  REQUIRED_OBJECT_KINDS,
  WORM_RETENTION_OBJECT_FILE_NAMES,
  validateProtocolPolicy,
  validateRetainedZipPacket,
  validateTrustPolicy,
  verifyAnchorApprovals,
  verifyWormRetentionBundle,
} from "../verify_container_runtime_worm_retention.mjs";

export const WORM_AUTHORITY_REVIEW_CONTRACT =
  "cinatoken-container-runtime-worm-authority-review-v1";
export const WORM_ASSEMBLY_CONTRACT =
  "cinatoken-container-runtime-worm-assembly-v1";
export const WORM_SIGNING_REQUEST_CONTRACT =
  "cinatoken-container-runtime-worm-signing-request-v1";
export const WORM_APPROVAL_RECEIPT_CONTRACT =
  "cinatoken-container-runtime-worm-approval-receipt-v1";
export const WORM_CEREMONY_APPROVAL_DOMAIN =
  "cinatoken-container-runtime-worm-ceremony-approval-v1";

export const WORM_RECEIPT_KEYS = Object.freeze([
  "baseline",
  "lock",
  "lockRevoke",
  "lockVerify",
  "publish",
  "objectReadback",
  "probe",
  "publisherRevoke",
  "publisherVerify",
  "postReadback",
  "finalLock",
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PROTOCOL_POLICY_PATH = resolve(
  ROOT,
  "config/container-runtime-worm-retention-policy.json",
);
const VERIFIER_PATH = resolve(
  ROOT,
  "tools/verify_container_runtime_worm_retention.mjs",
);
const BUNDLE_LIBRARY_PATH = fileURLToPath(import.meta.url);

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_TRUST_POLICY_BYTES = 256 * 1024;
const MAX_REVIEW_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNING_REQUEST_BYTES = 1024 * 1024;
const MAX_APPROVAL_BYTES = 64 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_OBJECT_BYTES = 768 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 200_000;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_REMAINING_SECONDS = 3_600;

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PROHIBITED_FIELD_NAMES = new Set([
  "accesskey",
  "accesskeyid",
  "apikey",
  "apitoken",
  "authorization",
  "clientsecret",
  "cookie",
  "headers",
  "password",
  "privatekey",
  "requestbody",
  "responsebody",
  "secret",
  "secretaccesskey",
  "setcookie",
  "token",
  "tokenvalue",
]);

export class WormBundleError extends Error {}

export async function assembleWormBundle(options) {
  const now = requireDate(options.now ?? new Date(), "assembly time");
  const generatedAt = now.toISOString();
  const accountIdFile = await readStableFile(
    options.accountIdFile,
    "account ID file",
    128,
  );
  const accountId = decodeSingleLine(
    accountIdFile.bytes,
    "account ID file",
  );
  requireCondition(
    ACCOUNT_ID_PATTERN.test(accountId),
    "[assembly] account ID file is malformed",
  );

  const protocol = await loadProtocolPolicy();
  const protocolPolicySha256 = sha256Bytes(
    Buffer.from(canonicalJson(protocol), "utf8"),
  );
  const trustFile = await readCanonicalJsonFile(
    options.trustPolicyPath,
    "trust policy",
    MAX_TRUST_POLICY_BYTES,
  );
  const trustPolicySha256 = sha256Bytes(trustFile.bytes);
  const trust = validateTrustPolicy(
    trustFile.value,
    protocol,
    protocolPolicySha256,
    now,
  );
  requireCondition(
    trust.target.accountIdSha256 === sha256Text(accountId),
    "[assembly] account ID does not match the trust policy",
  );

  const receiptFiles = await readReceiptSet(options.receipts);
  const chain = normalizeReceiptChain({
    accountId,
    protocol,
    receipts: receiptFiles,
  });
  requireCondition(
    chain.accountIdSha256 === trust.target.accountIdSha256 &&
      chain.bucketName === trust.target.bucketName &&
      chain.jurisdiction === trust.target.jurisdiction &&
      chain.prefix.startsWith(trust.target.prefixRoot),
    "[assembly] receipt chain target does not match the trust policy",
  );
  validateGlobalReceiptIdentities(receiptFiles);

  const reviewFile = await readCanonicalJsonFile(
    options.authorityReviewPath,
    "authority review",
    MAX_REVIEW_BYTES,
  );
  rejectProhibitedFields(reviewFile.value, "authority review");
  const review = validateAuthorityReview({
    value: reviewFile.value,
    chain,
    receipts: receiptFiles,
    trust,
    generatedAt,
  });
  const expiresAt = chooseManifestExpiry({
    generatedAt,
    requestedExpiresAt: options.expiresAt ?? null,
    review,
    trust,
  });
  validateReviewExpiry(review, expiresAt);

  const objectSourceRoot = await requireExactObjectDirectory(
    options.objectsDirectory,
  );
  const provenance = await deriveProvenance({
    objectSourceRoot,
    chain,
    protocol,
  });
  const commitSha = provenance.commitSha;
  const evidenceValues = buildEvidenceValues({
    ceremonyId: review.ceremonyId,
    expiresAt,
    chain,
    receipts: receiptFiles,
    review,
  });
  validateAssemblyChronology({
    evidenceValues,
    generatedAt,
    expiresAt,
    trust,
  });

  const outputRoot = requireFreshOutputPath(options.outputDirectory);
  let outputOwnership = null;
  try {
    outputOwnership = await createOwnedOutputDirectory(outputRoot);
    const evidenceRoot = join(outputRoot, "evidence");
    const objectsRoot = join(outputRoot, "objects");
    const sourcesRoot = join(outputRoot, "sources");
    const sourceReceiptsRoot = join(sourcesRoot, "receipts");
    await mkdir(evidenceRoot, { mode: 0o700 });
    await mkdir(objectsRoot, { mode: 0o700 });
    await mkdir(sourcesRoot, { mode: 0o700 });
    await mkdir(sourceReceiptsRoot, { mode: 0o700 });

    const sourceRecords = [];
    const authorityReviewCopy = await copyStableFile({
      source: reviewFile.realPath,
      destination: join(sourcesRoot, "authority-review.json"),
      label: "authority review source",
      maxBytes: MAX_REVIEW_BYTES,
      expectedBytes: reviewFile.bytes.length,
      expectedSha256: sha256Bytes(reviewFile.bytes),
    });
    sourceRecords.push({
      kind: "authority-review",
      path: "sources/authority-review.json",
      bytes: authorityReviewCopy.bytes,
      sha256: authorityReviewCopy.sha256,
    });
    for (const key of WORM_RECEIPT_KEYS) {
      const receipt = receiptFiles[key];
      const copied = await copyStableFile({
        source: receipt.path,
        destination: join(sourceReceiptsRoot, `${key}.json`),
        label: `${key} receipt source`,
        maxBytes: MAX_RECEIPT_BYTES,
        expectedBytes: receipt.bytes.length,
        expectedSha256: sha256Bytes(receipt.bytes),
      });
      sourceRecords.push({
        kind: key,
        path: `sources/receipts/${key}.json`,
        bytes: copied.bytes,
        sha256: copied.sha256,
      });
    }

    const objectRecords = [];
    let totalObjectBytes = 0;
    for (const kind of REQUIRED_OBJECT_KINDS) {
      const expected = chain.objects.find((entry) => entry.kind === kind);
      requireCondition(
        expected !== undefined,
        `[assembly] missing ${kind} receipt object`,
      );
      const fileName = WORM_RETENTION_OBJECT_FILE_NAMES[kind];
      const copied = await copyStableFile({
        source: join(objectSourceRoot, fileName),
        destination: join(objectsRoot, fileName),
        label: `${kind} retained object`,
        maxBytes: MAX_OBJECT_BYTES,
        expectedBytes: expected.bytes,
        expectedSha256: expected.sha256,
      });
      totalObjectBytes += copied.bytes;
      requireCondition(
        totalObjectBytes <= MAX_TOTAL_OBJECT_BYTES,
        "[assembly] retained objects exceed aggregate byte bound",
      );
      objectRecords.push({
        kind,
        path: `objects/${fileName}`,
        bytes: copied.bytes,
        sha256: copied.sha256,
      });
    }

    const evidenceRecords = [];
    for (const kind of REQUIRED_EVIDENCE_KINDS) {
      const value = evidenceValues.get(kind);
      const destination = join(evidenceRoot, `${kind}.json`);
      const bytes = await writeCanonicalJsonExclusive(destination, value);
      evidenceRecords.push({
        kind,
        path: `evidence/${kind}.json`,
        bytes: bytes.length,
        sha256: sha256Bytes(bytes),
        capturedAt: value.capturedAt,
        expiresAt: value.expiresAt,
      });
    }

    const subject = {
      environment: protocol.environment,
      repository: protocol.repository,
      commitSha,
      ceremonyId: review.ceremonyId,
      generatedAt,
      expiresAt,
      provider: protocol.provider,
      accountIdSha256: chain.accountIdSha256,
      bucketName: chain.bucketName,
      jurisdiction: chain.jurisdiction,
      prefix: chain.prefix,
      policyId: trust.policyId,
      provenance: provenance.subject,
      evidence: evidenceRecords,
    };
    const subjectDigestSha256 = sha256Bytes(
      Buffer.from(canonicalJson(subject), "utf8"),
    );
    const unsignedManifest = {
      schemaVersion: 2,
      contract: MANIFEST_CONTRACT,
      subject,
      subjectDigestSha256,
      approvals: [],
    };
    const unsignedManifestPath = join(
      outputRoot,
      "unsigned-manifest.json",
    );
    const unsignedManifestBytes = await writeCanonicalJsonExclusive(
      unsignedManifestPath,
      unsignedManifest,
    );
    const message = anchorMessage(trust.policyId, subjectDigestSha256);
    const signingRequest = {
      schemaVersion: 1,
      contract: WORM_SIGNING_REQUEST_CONTRACT,
      assemblyContract: WORM_ASSEMBLY_CONTRACT,
      createdAt: generatedAt,
      cleanHostReplayRequired: true,
      policyId: trust.policyId,
      protocolPolicySha256,
      trustPolicySha256,
      ceremonyId: review.ceremonyId,
      subjectDigestSha256,
      unsignedManifestSha256: sha256Bytes(unsignedManifestBytes),
      signingMessageSha256: sha256Bytes(message),
      sources: sourceRecords,
      evidence: evidenceRecords.map((record) => ({
        kind: record.kind,
        path: record.path,
        bytes: record.bytes,
        sha256: record.sha256,
      })),
      objects: objectRecords,
    };
    const signingRequestPath = join(outputRoot, "signing-request.json");
    const signingRequestBytes = await writeCanonicalJsonExclusive(
      signingRequestPath,
      signingRequest,
    );

    await validateExactAssemblyLayout(outputRoot);
    await revalidateReceiptSet(receiptFiles);
    await revalidateStableFile(
      accountIdFile,
      "account ID file",
    );
    await revalidateStableFile(trustFile, "trust policy");
    await revalidateStableFile(reviewFile, "authority review");

    return {
      contractVersion: 1,
      status: "assembled",
      reportKind: "container-runtime-worm-bundle-assembly",
      outputDirectory: outputRoot,
      signingRequestSha256: sha256Bytes(signingRequestBytes),
      trustPolicySha256,
      subjectDigestSha256,
      credentialFree: true,
      networkRequests: false,
      approvalsComplete: false,
      wormRetentionVerified: false,
      s3Complete: false,
      registryDigestAuthorized: false,
      cloudflareDeploymentDigestVerified: false,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
    };
  } catch (error) {
    if (outputOwnership !== null) {
      await removeOwnedOutput(outputRoot, outputOwnership);
    }
    throw error;
  }
}

export async function signWormAnchor(options) {
  const now = requireDate(options.now ?? new Date(), "signing time");
  const role = options.role;
  const keyId = options.keyId;
  requireCondition(
    REQUIRED_APPROVAL_ROLES.includes(role) &&
      KEY_ID_PATTERN.test(keyId),
    "[signing] role or key ID is invalid",
  );
  const privateKeyBytes = Buffer.from(options.privateKeyBytes ?? []);
  requireCondition(
    privateKeyBytes.length > 0 &&
      privateKeyBytes.length <= MAX_PRIVATE_KEY_BYTES,
    "[signing] private key input is empty or oversized",
  );

  const assemblyRoot = await validateExactAssemblyLayout(
    options.assemblyDirectory,
  );
  const signingRequestFile = await readCanonicalJsonFile(
    join(assemblyRoot, "signing-request.json"),
    "signing request",
    MAX_SIGNING_REQUEST_BYTES,
  );
  const unsignedManifestFile = await readCanonicalJsonFile(
    join(assemblyRoot, "unsigned-manifest.json"),
    "unsigned manifest",
    MAX_MANIFEST_BYTES,
  );
  const protocol = await loadProtocolPolicy();
  const protocolPolicySha256 = sha256Bytes(
    Buffer.from(canonicalJson(protocol), "utf8"),
  );
  const trustFile = await readCanonicalJsonFile(
    options.trustPolicyPath,
    "trust policy",
    MAX_TRUST_POLICY_BYTES,
  );
  const trust = validateTrustPolicy(
    trustFile.value,
    protocol,
    protocolPolicySha256,
    now,
  );
  const request = validateSigningRequest({
    value: signingRequestFile.value,
    bytes: signingRequestFile.bytes,
    unsignedManifestFile,
    trust,
    protocolPolicySha256,
    trustPolicySha256: sha256Bytes(trustFile.bytes),
  });
  await validateAssemblyInventoryFiles(assemblyRoot, request);
  const trustedKey = trust.keyring.get(keyId);
  requireCondition(
    trustedKey?.role === role,
    "[signing] key is not trusted for the requested role",
  );

  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyBytes);
  } catch {
    throw new WormBundleError("[signing] private key input is malformed");
  } finally {
    privateKeyBytes.fill(0);
  }
  requireCondition(
    privateKey.asymmetricKeyType === "ed25519",
    "[signing] private key is not Ed25519",
  );
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiBase64 = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  requireCondition(
    publicKeySpkiBase64 === trustedKey.publicKeySpkiBase64,
    "[signing] private key does not match the trusted key ID",
  );
  const message = anchorMessage(
    trust.policyId,
    request.subjectDigestSha256,
  );
  const signature = signSignature(null, message, privateKey);
  const signingRequestSha256 = sha256Bytes(signingRequestFile.bytes);
  const ceremonyMessage = ceremonyApprovalMessage({
    role,
    keyId,
    protocolPolicySha256: request.protocolPolicySha256,
    trustPolicySha256: request.trustPolicySha256,
    policyId: request.policyId,
    ceremonyId: request.ceremonyId,
    subjectDigestSha256: request.subjectDigestSha256,
    signingRequestSha256,
  });
  const ceremonySignature = signSignature(
    null,
    ceremonyMessage,
    privateKey,
  );
  requireCondition(
    signature.length === 64 &&
      ceremonySignature.length === 64 &&
      verifySignature(null, message, trustedKey.publicKey, signature) &&
      verifySignature(
        null,
        ceremonyMessage,
        trustedKey.publicKey,
        ceremonySignature,
      ),
    "[signing] Ed25519 signature self-verification failed",
  );
  await revalidateStableFile(signingRequestFile, "signing request");
  await revalidateStableFile(
    unsignedManifestFile,
    "unsigned manifest",
  );
  await revalidateStableFile(trustFile, "trust policy");
  return {
    schemaVersion: 1,
    contract: WORM_APPROVAL_RECEIPT_CONTRACT,
    role,
    keyId,
    algorithm: "ed25519",
    policyId: trust.policyId,
    trustPolicySha256: request.trustPolicySha256,
    ceremonyId: request.ceremonyId,
    subjectDigestSha256: request.subjectDigestSha256,
    signingRequestSha256,
    signatureBase64Url: signature.toString("base64url"),
    ceremonySignatureBase64Url:
      ceremonySignature.toString("base64url"),
  };
}

export async function finalizeWormBundle(options) {
  const callerSuppliedNow = options.now !== undefined;
  const now = requireDate(options.now ?? new Date(), "finalization time");
  const assemblyRoot = await validateExactAssemblyLayout(
    options.assemblyDirectory,
  );
  const signingRequestFile = await readCanonicalJsonFile(
    join(assemblyRoot, "signing-request.json"),
    "signing request",
    MAX_SIGNING_REQUEST_BYTES,
  );
  const unsignedManifestFile = await readCanonicalJsonFile(
    join(assemblyRoot, "unsigned-manifest.json"),
    "unsigned manifest",
    MAX_MANIFEST_BYTES,
  );
  const protocol = await loadProtocolPolicy();
  const protocolPolicySha256 = sha256Bytes(
    Buffer.from(canonicalJson(protocol), "utf8"),
  );
  const trustFile = await readCanonicalJsonFile(
    options.trustPolicyPath,
    "trust policy",
    MAX_TRUST_POLICY_BYTES,
  );
  const trustPolicySha256 = sha256Bytes(trustFile.bytes);
  const trust = validateTrustPolicy(
    trustFile.value,
    protocol,
    protocolPolicySha256,
    now,
  );
  const request = validateSigningRequest({
    value: signingRequestFile.value,
    bytes: signingRequestFile.bytes,
    unsignedManifestFile,
    trust,
    protocolPolicySha256,
    trustPolicySha256,
  });
  await validateAssemblyInventoryFiles(assemblyRoot, request);
  const approvalFiles = await Promise.all(
    REQUIRED_APPROVAL_ROLES.map((role) =>
      readCanonicalJsonFile(
        options.approvalPaths?.[role],
        `${role} approval`,
        MAX_APPROVAL_BYTES,
      ),
    ),
  );
  const approvals = approvalFiles.map((file, index) =>
    validateApprovalReceipt({
      value: file.value,
      role: REQUIRED_APPROVAL_ROLES[index],
      request,
      trust,
      signingRequestSha256: sha256Bytes(signingRequestFile.bytes),
    }),
  );
  const manifest = {
    ...unsignedManifestFile.value,
    approvals: approvals.map((approval) => ({
      role: approval.role,
      keyId: approval.keyId,
      algorithm: approval.algorithm,
      signatureBase64Url: approval.signatureBase64Url,
    })),
  };
  verifyAnchorApprovals(
    manifest,
    trust,
    request.subjectDigestSha256,
  );

  const outputRoot = requireFreshOutputPath(options.outputDirectory);
  const decisionOutput =
    options.decisionOutputPath === undefined
      ? null
      : requireFreshOutputPath(options.decisionOutputPath);
  requireCondition(
    !isSameOrWithin(assemblyRoot, outputRoot) &&
      !isSameOrWithin(outputRoot, assemblyRoot),
    "[finalize] assembly and final bundle paths overlap",
  );
  if (decisionOutput !== null) {
    requireCondition(
      !isSameOrWithin(assemblyRoot, decisionOutput) &&
        !isSameOrWithin(outputRoot, decisionOutput),
      "[finalize] decision report must be outside assembly and bundle",
    );
  }
  let outputOwnership = null;
  try {
    outputOwnership = await createOwnedOutputDirectory(outputRoot);
    const evidenceRoot = join(outputRoot, "evidence");
    const objectsRoot = join(outputRoot, "objects");
    await mkdir(evidenceRoot, { mode: 0o700 });
    await mkdir(objectsRoot, { mode: 0o700 });
    for (const record of request.evidence) {
      await copyStableFile({
        source: join(assemblyRoot, ...record.path.split("/")),
        destination: join(outputRoot, ...record.path.split("/")),
        label: `${record.kind} evidence`,
        maxBytes: MAX_RECEIPT_BYTES,
        expectedBytes: record.bytes,
        expectedSha256: record.sha256,
      });
    }
    let totalObjectBytes = 0;
    for (const record of request.objects) {
      const copied = await copyStableFile({
        source: join(assemblyRoot, ...record.path.split("/")),
        destination: join(outputRoot, ...record.path.split("/")),
        label: `${record.kind} retained object`,
        maxBytes: MAX_OBJECT_BYTES,
        expectedBytes: record.bytes,
        expectedSha256: record.sha256,
      });
      totalObjectBytes += copied.bytes;
      requireCondition(
        totalObjectBytes <= MAX_TOTAL_OBJECT_BYTES,
        "[finalize] retained objects exceed aggregate byte bound",
      );
    }
    const manifestBytes = await writeCanonicalJsonExclusive(
      join(outputRoot, "manifest.json"),
      manifest,
    );
    await revalidateStableFile(signingRequestFile, "signing request");
    await revalidateStableFile(
      unsignedManifestFile,
      "unsigned manifest",
    );
    await revalidateStableFile(trustFile, "trust policy");
    for (let index = 0; index < approvalFiles.length; index += 1) {
      await revalidateStableFile(
        approvalFiles[index],
        `${REQUIRED_APPROVAL_ROLES[index]} approval`,
      );
    }
    const verifierKitBefore = await hashVerifierKit();
    const report = await verifyWormRetentionBundle({
      manifestPath: join(outputRoot, "manifest.json"),
      trustPolicyPath: trustFile.realPath,
      now,
    });
    const verifierKitSha256 = await hashVerifierKit();
    requireCondition(
      verifierKitSha256 === verifierKitBefore,
      "[finalize] verifier kit changed during replay",
    );
    const bundleTreeSha256 = sha256Bytes(
      Buffer.from(
        canonicalJson({
          manifestSha256: sha256Bytes(manifestBytes),
          evidence: request.evidence,
          objects: request.objects,
        }),
        "utf8",
      ),
    );
    const decisionReport = {
      ...report,
      finalizationContractVersion: 1,
      verifiedAt: now.toISOString(),
      verificationTimeSource: callerSuppliedNow
        ? "caller-supplied"
        : "system-clock",
      historicalTimeOverrideAcceptedByProductionCli: false,
      protocolPolicySha256,
      trustPolicySha256,
      manifestSha256: sha256Bytes(manifestBytes),
      signingRequestSha256: sha256Bytes(signingRequestFile.bytes),
      sourceInventorySha256: sha256Bytes(
        Buffer.from(canonicalJson(request.sources), "utf8"),
      ),
      bundleTreeSha256,
      verifierKitSha256,
      approvalReceiptSha256: Object.fromEntries(
        approvalFiles.map((file, index) => [
          REQUIRED_APPROVAL_ROLES[index],
          sha256Bytes(file.bytes),
        ]),
      ),
      cleanHostReplayRequired: true,
      localReplayVerified: true,
      externalDecisionReportRequired: true,
    };
    if (decisionOutput !== null) {
      await writeCanonicalJsonExclusive(
        decisionOutput,
        decisionReport,
      );
    }
    return decisionReport;
  } catch (error) {
    if (outputOwnership !== null) {
      await removeOwnedOutput(outputRoot, outputOwnership);
    }
    throw error;
  }
}

async function hashVerifierKit() {
  const entries = [];
  for (const [name, file] of [
    ["bundle-library", BUNDLE_LIBRARY_PATH],
    ["retention-verifier", VERIFIER_PATH],
  ]) {
    const read = await readStableFile(
      file,
      `${name} source`,
      4 * 1024 * 1024,
    );
    entries.push({
      name,
      bytes: read.bytes.length,
      sha256: sha256Bytes(read.bytes),
    });
    await revalidateStableFile(read, `${name} source`);
  }
  return sha256Bytes(
    Buffer.from(canonicalJson(entries), "utf8"),
  );
}

export async function writeApprovalReceiptExclusive(file, value) {
  validateApprovalReceiptEnvelope(value);
  return writeCanonicalJsonExclusive(file, value);
}

function normalizeReceiptChain({ accountId, protocol, receipts }) {
  const baselineToLock = normalizePublishPredecessors({
    accountId,
    baselineReceipt: receipts.baseline.value,
    baselineReceiptText: receipts.baseline.text,
    lockRevocationReceipt: receipts.lockVerify.value,
    lockRevocationReceiptText: receipts.lockVerify.text,
  });
  const lock = normalizeLockPredecessor({
    accountId,
    receipt: receipts.lock.value,
    receiptText: receipts.lock.text,
  });
  const lockRevoke = normalizeRevokePredecessor({
    accountId,
    receipt: receipts.lockRevoke.value,
    receiptText: receipts.lockRevoke.text,
  });
  requireCondition(
    receipts.lockVerify.value.target.lockReceiptSha256 ===
        sha256Bytes(receipts.lock.bytes) &&
      receipts.lockVerify.value.target.revokeReceiptSha256 ===
        sha256Bytes(receipts.lockRevoke.bytes) &&
      lock.lockReceiptSha256 === sha256Bytes(receipts.lock.bytes) &&
      lockRevoke.revokeReceiptSha256 ===
        sha256Bytes(receipts.lockRevoke.bytes),
    "[assembly] B2/B3 receipt byte binding drifted",
  );
  requireCondition(
    baselineToLock.baselineReceiptSha256 ===
        sha256Bytes(receipts.baseline.bytes) &&
      baselineToLock.lockRevocationReceiptSha256 ===
        sha256Bytes(receipts.lockVerify.bytes),
    "[assembly] B1/B3 receipt byte binding drifted",
  );

  let target = normalizeProbePredecessors({
    accountId,
    policy: protocol,
    publishReceipt: receipts.publish.value,
    publishReceiptText: receipts.publish.text,
    readbackReceipt: receipts.objectReadback.value,
    readbackReceiptText: receipts.objectReadback.text,
    lockRevocationReceipt: receipts.lockVerify.value,
    lockRevocationReceiptText: receipts.lockVerify.text,
  });
  requireCondition(
    target.baselineReceiptSha256 ===
        sha256Bytes(receipts.baseline.bytes) &&
      target.lockReceiptSha256 === sha256Bytes(receipts.lock.bytes) &&
      target.lockRevocationReceiptSha256 ===
        sha256Bytes(receipts.lockVerify.bytes) &&
      target.publishReceiptSha256 ===
        sha256Bytes(receipts.publish.bytes) &&
      target.objectReadbackReceiptSha256 ===
        sha256Bytes(receipts.objectReadback.bytes),
    "[assembly] B1-B4 receipt chain drifted",
  );
  target = normalizeProbeReceipt({
    target,
    receipt: receipts.probe.value,
    receiptText: receipts.probe.text,
  });
  target = normalizePublisherRevokeReceipt({
    target,
    receipt: receipts.publisherRevoke.value,
    receiptText: receipts.publisherRevoke.text,
  });
  target = normalizePublisherVerifyReceipt({
    target,
    receipt: receipts.publisherVerify.value,
    receiptText: receipts.publisherVerify.text,
  });
  target = normalizePostReadbackReceipt({
    target,
    receipt: receipts.postReadback.value,
    receiptText: receipts.postReadback.text,
  });
  target = normalizeFinalLockPredecessors({
    target,
    lockReceipt: receipts.lock.value,
    lockReceiptText: receipts.lock.text,
  });
  target = normalizeFinalLockReadbackReceipt({
    target,
    receipt: receipts.finalLock.value,
    receiptText: receipts.finalLock.text,
  });
  requireCondition(
    target.probeReceiptSha256 === sha256Bytes(receipts.probe.bytes) &&
      target.revokeReceiptSha256 ===
        sha256Bytes(receipts.publisherRevoke.bytes) &&
      target.verifyReceiptSha256 ===
        sha256Bytes(receipts.publisherVerify.bytes) &&
      target.postReadbackReceiptSha256 ===
        sha256Bytes(receipts.postReadback.bytes) &&
      target.lockReadbackReceiptSha256 ===
        sha256Bytes(receipts.finalLock.bytes),
    "[assembly] B5 receipt byte binding drifted",
  );
  return target;
}

function validateAuthorityReview({
  value,
  chain,
  receipts,
  trust,
  generatedAt,
}) {
  const review = requireObject(value, "authority review");
  exactKeys(
    review,
    [
      "schemaVersion",
      "contract",
      "ceremonyId",
      "reviewedAt",
      "target",
      "secretMaterialCaptured",
      "permissionInventoriesReviewed",
      "authorities",
    ],
    "authority review",
  );
  requireCondition(
    review.schemaVersion === 1 &&
      review.contract === WORM_AUTHORITY_REVIEW_CONTRACT &&
      UUID_PATTERN.test(review.ceremonyId) &&
      review.secretMaterialCaptured === false &&
      review.permissionInventoriesReviewed === true,
    "[assembly] authority review identity drifted",
  );
  const reviewedAt = requireTimestamp(
    review.reviewedAt,
    "authority review time",
  );
  const generatedAtDate = requireTimestamp(
    generatedAt,
    "assembly generatedAt",
  );
  requireCondition(
    reviewedAt >=
        requireTimestamp(
          chain.lockReadbackCapturedAt,
          "final lock readback time",
        ) &&
      reviewedAt <= generatedAtDate &&
      generatedAtDate.getTime() - reviewedAt.getTime() <=
        trust.maximumEvidenceAgeSeconds * 1_000,
    "[assembly] authority review is stale or out of order",
  );
  const target = requireObject(review.target, "authority review target");
  exactKeys(
    target,
    ["accountIdSha256", "bucketName", "jurisdiction", "prefix"],
    "authority review target",
  );
  requireCondition(
    target.accountIdSha256 === chain.accountIdSha256 &&
      target.bucketName === chain.bucketName &&
      target.jurisdiction === chain.jurisdiction &&
      target.prefix === chain.prefix,
    "[assembly] authority review target drifted",
  );
  requireCondition(
    Array.isArray(review.authorities) &&
      review.authorities.length === REQUIRED_AUTHORITY_PROFILES.length,
    "[assembly] authority review is incomplete",
  );
  const expectedIds = new Map([
    ["publisher", chain.publisherCredentialIdSha256],
    ["lock-operator", chain.lockOperatorCredentialIdSha256],
    ["object-verifier", chain.objectVerifierCredentialIdSha256],
    ["lock-verifier", chain.lockVerifierCredentialIdSha256],
    [
      "lifecycle-operator",
      chain.lifecycleOperatorCredentialIdSha256,
    ],
    [
      "lifecycle-verifier",
      chain.lifecycleVerifierCredentialIdSha256,
    ],
  ]);
  const observedExpiries = observedCredentialExpiries(receipts);
  const ids = new Set();
  const authorities = review.authorities.map((raw, index) => {
    const authority = requireObject(raw, "authority review entry");
    exactKeys(
      authority,
      [
        "role",
        "credentialType",
        "credentialIdSha256",
        "scopeType",
        "accountIdSha256",
        "bucketName",
        "prefix",
        "permissions",
        "capabilities",
        "expiresAt",
      ],
      "authority review entry",
    );
    const profile = REQUIRED_AUTHORITY_PROFILES[index];
    const r2Scoped = profile.scopeType === "r2-bucket-prefix";
    const expiresAt = requireTimestamp(
      authority.expiresAt,
      `${profile.role} authority expiry`,
    );
    requireCondition(
      authority.role === profile.role &&
        authority.credentialType === profile.credentialType &&
        authority.credentialIdSha256 === expectedIds.get(profile.role) &&
        authority.scopeType === profile.scopeType &&
        authority.accountIdSha256 === chain.accountIdSha256 &&
        (r2Scoped
          ? authority.bucketName === chain.bucketName &&
            authority.prefix === chain.prefix
          : authority.bucketName === null && authority.prefix === null) &&
        sameJson(authority.permissions, profile.permissions) &&
        sameJson(authority.capabilities, profile.capabilities) &&
        expiresAt > reviewedAt &&
        expiresAt.getTime() - reviewedAt.getTime() <=
          MAX_CREDENTIAL_REMAINING_SECONDS * 1_000 &&
        !ids.has(authority.credentialIdSha256),
      `[assembly] ${profile.role} permission inventory drifted`,
    );
    const observedExpiry = observedExpiries.get(profile.role);
    requireCondition(
      observedExpiry === undefined ||
        authority.expiresAt === observedExpiry,
      `[assembly] ${profile.role} reviewed expiry drifted`,
    );
    ids.add(authority.credentialIdSha256);
    return { ...authority, expiresAtDate: expiresAt };
  });
  return {
    ...review,
    reviewedAtDate: reviewedAt,
    authorities,
  };
}

function observedCredentialExpiries(receipts) {
  const values = new Map([
    ["lock-operator", receipts.lock.value.credential.expiresAt],
    [
      "lock-verifier",
      receipts.finalLock.value.credential.expiresAt,
    ],
    [
      "lifecycle-operator",
      receipts.lockRevoke.value.authority.expiresAt,
    ],
    [
      "lifecycle-verifier",
      receipts.lockVerify.value.authority.expiresAt,
    ],
  ]);
  requireCondition(
    receipts.publisherRevoke.value.authority.expiresAt ===
        values.get("lifecycle-operator") &&
      receipts.publisherVerify.value.authority.expiresAt ===
        values.get("lifecycle-verifier"),
    "[assembly] lifecycle credential expiry drifted between ceremonies",
  );
  return values;
}

function chooseManifestExpiry({
  generatedAt,
  requestedExpiresAt,
  review,
  trust,
}) {
  const generated = requireTimestamp(generatedAt, "manifest generatedAt");
  const earliestCredentialExpiry = new Date(
    Math.min(
      ...review.authorities.map((entry) =>
        entry.expiresAtDate.getTime(),
      ),
    ),
  );
  const maximum = new Date(
    generated.getTime() + trust.maximumManifestLifetimeSeconds * 1_000,
  );
  const selected =
    requestedExpiresAt === null
      ? new Date(
          Math.min(maximum.getTime(), earliestCredentialExpiry.getTime()),
        )
      : requireTimestamp(requestedExpiresAt, "requested manifest expiry");
  requireCondition(
    selected > generated &&
      selected <= maximum &&
      selected <= earliestCredentialExpiry,
    "[assembly] manifest expiry is outside the reviewed boundary",
  );
  return selected.toISOString();
}

function validateReviewExpiry(review, expiresAt) {
  const expires = requireTimestamp(expiresAt, "manifest expiry");
  for (const authority of review.authorities) {
    requireCondition(
      authority.expiresAtDate >= expires,
      `[assembly] ${authority.role} expires before the manifest`,
    );
  }
}

function buildEvidenceValues({
  ceremonyId,
  expiresAt,
  chain,
  receipts,
  review,
}) {
  const values = new Map();
  values.set(
    "authority-boundary",
    evidenceEnvelope(
      "authority-boundary",
      ceremonyId,
      review.reviewedAt,
      expiresAt,
      {
        accountIdSha256: chain.accountIdSha256,
        bucketName: chain.bucketName,
        prefix: chain.prefix,
        secretMaterialCaptured: false,
        allCredentialIdsDistinct: true,
        permissionInventoriesReviewed: true,
        authorities: review.authorities.map(
          ({ expiresAtDate: _ignored, ...authority }) => authority,
        ),
      },
    ),
  );
  values.set(
    "lock-operator-revocation",
    lifecycleEvidence({
      kind: "lock-operator-revocation",
      ceremonyId,
      expiresAt,
      chain,
      targetRole: "lock-operator",
      predecessor: receipts.lock,
      revoke: receipts.lockRevoke,
      verify: receipts.lockVerify,
    }),
  );
  values.set(
    "object-readback",
    evidenceEnvelope(
      "object-readback",
      ceremonyId,
      chain.objectReadbackCapturedAt,
      expiresAt,
      {
        accountIdSha256: chain.accountIdSha256,
        bucketName: chain.bucketName,
        jurisdiction: chain.jurisdiction,
        prefix: chain.prefix,
        objectVerifierCredentialIdSha256:
          chain.objectVerifierCredentialIdSha256,
        baselineObservedAt: chain.baselineObservedAt,
        baselinePaginationComplete: true,
        preexistingObjectCount: 0,
        multipartUploadCount: 0,
        unknownObjectCount: 0,
        finalPaginationComplete: true,
        createOnlyWritesVerified: true,
        awsS3ObjectLockHeadersUsed: false,
        objects: chain.objects.map((entry) => ({
          kind: entry.kind,
          path: entry.path,
          key: entry.key,
          bytes: entry.bytes,
          sha256: entry.sha256,
          etag: entry.etag,
          contentType: entry.contentType,
          uploadedAt: entry.uploadedAt,
          uploadHttpStatus: entry.uploadHttpStatus,
          uploadRequestId: entry.uploadRequestId,
          readBackAt: entry.readBackAt,
          httpStatus: entry.httpStatus,
          providerRequestId: entry.providerRequestId,
          customMetadata: entry.customMetadata,
        })),
      },
    ),
  );
  values.set(
    "enforcement-probes",
    evidenceEnvelope(
      "enforcement-probes",
      ceremonyId,
      chain.postReadbackCapturedAt,
      expiresAt,
      {
        accountIdSha256: chain.accountIdSha256,
        bucketName: chain.bucketName,
        jurisdiction: chain.jurisdiction,
        prefix: chain.prefix,
        publisherCredentialIdSha256:
          chain.publisherCredentialIdSha256,
        objectVerifierCredentialIdSha256:
          chain.objectVerifierCredentialIdSha256,
        targetObjectKind: chain.probeObject.kind,
        targetKey: chain.probeObject.key,
        originalSha256: chain.probeObject.sha256,
        originalBytes: chain.probeObject.bytes,
        publisherPreflight: chain.publisherPreflight,
        overwrite: chain.overwriteProbe,
        delete: chain.deleteProbe,
        finalReadback: chain.finalReadback,
      },
    ),
  );
  values.set(
    "publisher-revocation",
    lifecycleEvidence({
      kind: "publisher-revocation",
      ceremonyId,
      expiresAt,
      chain,
      targetRole: "publisher",
      predecessor: receipts.probe,
      revoke: receipts.publisherRevoke,
      verify: receipts.publisherVerify,
    }),
  );
  values.set(
    "lock-readback",
    evidenceEnvelope(
      "lock-readback",
      ceremonyId,
      chain.lockReadbackCapturedAt,
      expiresAt,
      chain.lockReadbackFacts,
    ),
  );
  return values;
}

function lifecycleEvidence({
  kind,
  ceremonyId,
  expiresAt,
  chain,
  targetRole,
  predecessor,
  revoke,
  verify,
}) {
  const targetCredentialIdSha256 =
    targetRole === "publisher"
      ? chain.publisherCredentialIdSha256
      : chain.lockOperatorCredentialIdSha256;
  const revokeFacts = revoke.value.facts;
  const verifyFacts = verify.value.facts;
  const deletionOperation = revoke.value.providerOperations.find(
    (entry) => entry.method === "DELETE",
  );
  requireCondition(
    deletionOperation !== undefined,
    `[assembly] ${targetRole} deletion operation is absent`,
  );
  const apiSurface = "cloudflare-account-token-api";
  const facts = {
    accountIdSha256: chain.accountIdSha256,
    bucketName: chain.bucketName,
    prefix: chain.prefix,
    targetRole,
    targetCredentialIdSha256,
    lifecycleOperatorCredentialIdSha256:
      chain.lifecycleOperatorCredentialIdSha256,
    lifecycleVerifierCredentialIdSha256:
      chain.lifecycleVerifierCredentialIdSha256,
    apiSurface,
    targetBindingSha256: sha256Bytes(
      Buffer.from(
        canonicalJson({
          apiSurface,
          accountIdSha256: chain.accountIdSha256,
          targetCredentialIdSha256,
        }),
        "utf8",
      ),
    ),
    predecessorReceiptFileSha256: sha256Bytes(predecessor.bytes),
    revokeReceiptFileSha256: sha256Bytes(revoke.bytes),
    verifyReceiptFileSha256: sha256Bytes(verify.bytes),
    operatorSelfVerifiedAt: revoke.value.authority.selfVerifiedAt,
    deletion: {
      at: revokeFacts.deletedAt,
      httpStatus:
        revokeFacts.deletionHttpStatus,
      providerRequestId: revokeFacts.deletionRequestId,
      responseBodySha256: deletionOperation.responseBodySha256,
      resultIdSha256: revokeFacts.deletionResultIdSha256,
    },
    operatorReadback: {
      at: revokeFacts.operatorReadbackAt,
      httpStatus: revokeFacts.operatorReadbackHttpStatus,
      providerRequestId: revokeFacts.operatorReadbackRequestId,
      responseBodySha256:
        revokeFacts.operatorReadbackResponseBodySha256,
      errorCodes: revokeFacts.operatorReadbackErrorCodes,
    },
    verifierSelfVerifiedAt: verify.value.authority.selfVerifiedAt,
    independentReadback: {
      at: verifyFacts.independentReadbackAt,
      httpStatus: verifyFacts.independentReadbackHttpStatus,
      providerRequestId: verifyFacts.independentReadbackRequestId,
      responseBodySha256:
        verifyFacts.independentReadbackResponseBodySha256,
      errorCodes: verifyFacts.independentReadbackErrorCodes,
    },
    targetAbsenceIndependentlyObserved: true,
  };
  return evidenceEnvelope(
    kind,
    ceremonyId,
    verify.value.capturedAt,
    expiresAt,
    facts,
  );
}

function evidenceEnvelope(kind, ceremonyId, capturedAt, expiresAt, facts) {
  return {
    schemaVersion: 2,
    contract: EVIDENCE_CONTRACT,
    kind,
    ceremonyId,
    capturedAt,
    expiresAt,
    status: "pass",
    facts,
  };
}

async function deriveProvenance({
  objectSourceRoot,
  chain,
  protocol,
}) {
  const packetFiles = [];
  for (const kind of [
    "source-evidence-packet",
    "provenance-evidence-packet",
  ]) {
    const expected = chain.objects.find((entry) => entry.kind === kind);
    requireCondition(
      expected !== undefined,
      `[assembly] ${kind} receipt record is absent`,
    );
    const file = await readStableFile(
      join(
        objectSourceRoot,
        WORM_RETENTION_OBJECT_FILE_NAMES[kind],
      ),
      kind,
      MAX_OBJECT_BYTES,
    );
    requireCondition(
      file.bytes.length === expected.bytes &&
        sha256Bytes(file.bytes) === expected.sha256,
      `[assembly] ${kind} source digest drifted`,
    );
    validateRetainedZipPacket(file.bytes, kind);
    packetFiles.push([file, kind]);
  }
  const reportPath = join(
    objectSourceRoot,
    WORM_RETENTION_OBJECT_FILE_NAMES["provenance-report"],
  );
  const reportFile = await readStableFile(
    reportPath,
    "provenance report",
    16 * 1024 * 1024,
  );
  const report = parseJson(reportFile.bytes, "provenance report");
  auditJsonShape(report, "provenance report");
  rejectProhibitedFields(report, "provenance report");
  const source = requireObject(report.source, "provenance source");
  const signer = requireObject(report.signer, "provenance signer");
  const reportSubject = requireObject(
    report.subject,
    "provenance subject",
  );
  const commitValues = new Set(
    chain.objects.map(
      (entry) => entry.customMetadata.repositoryCommit,
    ),
  );
  requireCondition(
    commitValues.size === 1 &&
      GIT_SHA_PATTERN.test(source.commit) &&
      source.commit === signer.commit &&
      source.commit === [...commitValues][0] &&
      source.repository === protocol.repository &&
      Number.isSafeInteger(source.runId) &&
      source.runId > 0 &&
      Number.isSafeInteger(signer.runId) &&
      signer.runId > 0 &&
      source.runId !== signer.runId,
    "[assembly] retained provenance identity drifted",
  );
  const byKind = new Map(chain.objects.map((entry) => [entry.kind, entry]));
  const digest = (kind) => {
    const value = byKind.get(kind)?.sha256;
    requireCondition(
      SHA256_PATTERN.test(value),
      `[assembly] ${kind} digest is absent`,
    );
    return value;
  };
  const subject = {
    sourceRunId: source.runId,
    signerRunId: signer.runId,
    sourceArtifactSha256: digest("source-evidence-packet"),
    provenanceArtifactSha256: digest("provenance-evidence-packet"),
    statementSha256: digest("provenance-statement"),
    bundleSha256: digest("sigstore-bundle"),
    subject: {
      archiveSha256: requireSha256(
        reportSubject.archiveSha256,
        "archive digest",
      ),
      ociIndexSha256: stripSha256(
        reportSubject.ociIndexDigest,
        "OCI index digest",
      ),
      ociManifestSha256: stripSha256(
        reportSubject.ociManifestDigest,
        "OCI manifest digest",
      ),
      ociConfigSha256: stripSha256(
        reportSubject.ociConfigDigest,
        "OCI config digest",
      ),
      runtimeBinarySha256: requireSha256(
        reportSubject.runtimeBinarySha256,
        "runtime binary digest",
      ),
      sbomSha256: requireSha256(
        reportSubject.sbomSha256,
        "SBOM digest",
      ),
      vulnerabilityScanSha256: requireSha256(
        reportSubject.vulnerabilityScanSha256,
        "vulnerability scan digest",
      ),
    },
  };
  requireCondition(
    subject.statementSha256 === chain.statementSha256,
    "[assembly] statement digest does not address the receipt prefix",
  );
  await revalidateStableFile(reportFile, "provenance report");
  for (const [file, label] of packetFiles) {
    await revalidateStableFile(file, label);
  }
  return { commitSha: source.commit, subject };
}

function validateAssemblyChronology({
  evidenceValues,
  generatedAt,
  expiresAt,
  trust,
}) {
  const generated = requireTimestamp(generatedAt, "manifest generatedAt");
  const expires = requireTimestamp(expiresAt, "manifest expiresAt");
  requireCondition(
    generated < expires &&
      expires.getTime() - generated.getTime() <=
        trust.maximumManifestLifetimeSeconds * 1_000,
    "[assembly] manifest lifetime is invalid",
  );
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    const evidence = evidenceValues.get(kind);
    const captured = requireTimestamp(
      evidence.capturedAt,
      `${kind} capture time`,
    );
    requireCondition(
      captured <= generated &&
        generated.getTime() - captured.getTime() <=
          trust.maximumEvidenceAgeSeconds * 1_000 &&
        captured < expires,
      `[assembly] ${kind} evidence is stale or out of order`,
    );
  }
}

function validateGlobalReceiptIdentities(receipts) {
  const digests = new Set();
  const requestIds = new Map();
  for (const key of WORM_RECEIPT_KEYS) {
    const receipt = receipts[key];
    const digest = sha256Bytes(receipt.bytes);
    requireCondition(
      !digests.has(digest),
      "[assembly] receipt file digests are not globally distinct",
    );
    digests.add(digest);
    for (const operation of receipt.value.providerOperations ?? []) {
      if (
        operation !== null &&
        typeof operation === "object" &&
        typeof operation.providerRequestId === "string"
      ) {
        const previous = requestIds.get(operation.providerRequestId);
        requireCondition(
          previous === undefined,
          `[assembly] provider request ID is reused by ${previous} and ${key}`,
        );
        requestIds.set(operation.providerRequestId, key);
      }
    }
  }
}

function validateSigningRequest({
  value,
  bytes,
  unsignedManifestFile,
  trust,
  protocolPolicySha256,
  trustPolicySha256,
}) {
  const request = requireObject(value, "signing request");
  exactKeys(
    request,
    [
      "schemaVersion",
      "contract",
      "assemblyContract",
      "createdAt",
      "cleanHostReplayRequired",
      "policyId",
      "protocolPolicySha256",
      "trustPolicySha256",
      "ceremonyId",
      "subjectDigestSha256",
      "unsignedManifestSha256",
      "signingMessageSha256",
      "sources",
      "evidence",
      "objects",
    ],
    "signing request",
  );
  requireCondition(
    request.schemaVersion === 1 &&
      request.contract === WORM_SIGNING_REQUEST_CONTRACT &&
      request.assemblyContract === WORM_ASSEMBLY_CONTRACT &&
      request.cleanHostReplayRequired === true &&
      request.policyId === trust.policyId &&
      request.protocolPolicySha256 === protocolPolicySha256 &&
      request.trustPolicySha256 === trustPolicySha256 &&
      UUID_PATTERN.test(request.ceremonyId) &&
      SHA256_PATTERN.test(request.subjectDigestSha256) &&
      request.unsignedManifestSha256 ===
        sha256Bytes(unsignedManifestFile.bytes) &&
      request.signingMessageSha256 ===
        sha256Bytes(
          anchorMessage(
            request.policyId,
            request.subjectDigestSha256,
          ),
        ),
    "[signing] signing request identity drifted",
  );
  requireTimestamp(request.createdAt, "signing request createdAt");
  const manifest = requireObject(
    unsignedManifestFile.value,
    "unsigned manifest",
  );
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "contract",
      "subject",
      "subjectDigestSha256",
      "approvals",
    ],
    "unsigned manifest",
  );
  requireCondition(
    manifest.schemaVersion === 2 &&
      manifest.contract === MANIFEST_CONTRACT &&
      manifest.subject.policyId === trust.policyId &&
      manifest.subject.ceremonyId === request.ceremonyId &&
      manifest.subjectDigestSha256 === request.subjectDigestSha256 &&
      sha256Bytes(
        Buffer.from(canonicalJson(manifest.subject), "utf8"),
      ) === request.subjectDigestSha256 &&
      Array.isArray(manifest.approvals) &&
      manifest.approvals.length === 0,
    "[signing] unsigned manifest drifted",
  );
  validateSigningInventory(
    request.sources,
    ["authority-review", ...WORM_RECEIPT_KEYS],
    "sources",
  );
  validateSigningInventory(
    request.evidence,
    REQUIRED_EVIDENCE_KINDS,
    "evidence",
  );
  validateSigningInventory(
    request.objects,
    REQUIRED_OBJECT_KINDS,
    "objects",
  );
  requireCondition(
    bytes.length <= MAX_SIGNING_REQUEST_BYTES,
    "[signing] signing request is oversized",
  );
  return request;
}

async function validateAssemblyInventoryFiles(assemblyRoot, request) {
  const files = [];
  let totalObjectBytes = 0;
  for (const [directory, records, maxBytes] of [
    ["sources", request.sources, MAX_RECEIPT_BYTES],
    ["evidence", request.evidence, MAX_RECEIPT_BYTES],
    ["objects", request.objects, MAX_OBJECT_BYTES],
  ]) {
    for (const record of records) {
      const file = await readStableFile(
        boundedAssemblyPath(assemblyRoot, record.path),
        `${record.kind} ${directory} inventory file`,
        maxBytes,
      );
      requireCondition(
        file.bytes.length === record.bytes &&
          sha256Bytes(file.bytes) === record.sha256,
        `[signing] ${record.kind} ${directory} inventory digest drifted`,
      );
      if (directory === "objects") {
        totalObjectBytes += file.bytes.length;
        requireCondition(
          totalObjectBytes <= MAX_TOTAL_OBJECT_BYTES,
          "[signing] object inventory exceeds aggregate byte bound",
        );
      }
      files.push([
        file,
        `${record.kind} ${directory} inventory file`,
      ]);
    }
  }
  for (const [file, label] of files) {
    await revalidateStableFile(file, label);
  }
}

function boundedAssemblyPath(root, value) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      /^(?:sources|evidence|objects)\/[A-Za-z0-9._/-]+$/.test(value) &&
      !value.split("/").includes(".."),
    "[layout] assembly inventory path is malformed",
  );
  const candidate = resolve(root, ...value.split("/"));
  requireCondition(
    isSameOrWithin(root, candidate) && !isSamePath(root, candidate),
    "[layout] assembly inventory path escapes its root",
  );
  return candidate;
}

function validateSigningInventory(values, kinds, directory) {
  requireCondition(
    Array.isArray(values) && values.length === kinds.length,
    `[signing] ${directory} inventory is incomplete`,
  );
  for (let index = 0; index < kinds.length; index += 1) {
    const record = requireObject(
      values[index],
      `${directory} inventory record`,
    );
    exactKeys(
      record,
      ["kind", "path", "bytes", "sha256"],
      `${directory} inventory record`,
    );
    const expectedKind = kinds[index];
    const expectedPath =
      directory === "sources"
        ? expectedKind === "authority-review"
          ? "sources/authority-review.json"
          : `sources/receipts/${expectedKind}.json`
        : directory === "evidence"
        ? `evidence/${expectedKind}.json`
        : `objects/${WORM_RETENTION_OBJECT_FILE_NAMES[expectedKind]}`;
    requireCondition(
      record.kind === expectedKind &&
        record.path === expectedPath &&
        Number.isSafeInteger(record.bytes) &&
        record.bytes > 0 &&
        SHA256_PATTERN.test(record.sha256),
      `[signing] ${directory} inventory drifted`,
    );
  }
}

function validateApprovalReceipt({
  value,
  role,
  request,
  trust,
  signingRequestSha256,
}) {
  validateApprovalReceiptEnvelope(value);
  requireCondition(
    value.role === role &&
      value.policyId === request.policyId &&
      value.trustPolicySha256 === request.trustPolicySha256 &&
      value.ceremonyId === request.ceremonyId &&
      value.subjectDigestSha256 === request.subjectDigestSha256 &&
      value.signingRequestSha256 === signingRequestSha256,
    `[finalize] ${role} approval binding drifted`,
  );
  const key = trust.keyring.get(value.keyId);
  const ceremonyMessage = ceremonyApprovalMessage({
    role: value.role,
    keyId: value.keyId,
    protocolPolicySha256: request.protocolPolicySha256,
    trustPolicySha256: request.trustPolicySha256,
    policyId: request.policyId,
    ceremonyId: request.ceremonyId,
    subjectDigestSha256: request.subjectDigestSha256,
    signingRequestSha256,
  });
  requireCondition(
    key?.role === role &&
      verifySignature(
        null,
        ceremonyMessage,
        key.publicKey,
        Buffer.from(value.ceremonySignatureBase64Url, "base64url"),
      ),
    `[finalize] ${role} ceremony signature is invalid`,
  );
  return value;
}

function validateApprovalReceiptEnvelope(value) {
  const approval = requireObject(value, "approval receipt");
  exactKeys(
    approval,
    [
      "schemaVersion",
      "contract",
      "role",
      "keyId",
      "algorithm",
      "policyId",
      "trustPolicySha256",
      "ceremonyId",
      "subjectDigestSha256",
      "signingRequestSha256",
      "signatureBase64Url",
      "ceremonySignatureBase64Url",
    ],
    "approval receipt",
  );
  requireCondition(
    approval.schemaVersion === 1 &&
      approval.contract === WORM_APPROVAL_RECEIPT_CONTRACT &&
      REQUIRED_APPROVAL_ROLES.includes(approval.role) &&
      KEY_ID_PATTERN.test(approval.keyId) &&
      approval.algorithm === "ed25519" &&
      typeof approval.policyId === "string" &&
      SHA256_PATTERN.test(approval.trustPolicySha256) &&
      UUID_PATTERN.test(approval.ceremonyId) &&
      SHA256_PATTERN.test(approval.subjectDigestSha256) &&
      SHA256_PATTERN.test(approval.signingRequestSha256) &&
      /^[A-Za-z0-9_-]{86}$/.test(approval.signatureBase64Url) &&
      /^[A-Za-z0-9_-]{86}$/.test(
        approval.ceremonySignatureBase64Url,
      ),
    "[finalize] approval receipt identity is invalid",
  );
}

async function readReceiptSet(paths) {
  requireCondition(
    paths !== null && typeof paths === "object",
    "[assembly] receipt path map is required",
  );
  const entries = await Promise.all(
    WORM_RECEIPT_KEYS.map(async (key) => {
      const file = await readCanonicalReceiptFile(paths[key], {
        label: `${key} receipt`,
        maxBytes: MAX_RECEIPT_BYTES,
        errorFactory: (message) => new WormBundleError(message),
      });
      return [
        key,
        {
          ...file,
          bytes: Buffer.from(file.text, "utf8"),
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

async function revalidateReceiptSet(receipts) {
  for (const key of WORM_RECEIPT_KEYS) {
    const current = await readCanonicalReceiptFile(receipts[key].path, {
      label: `${key} receipt`,
      maxBytes: MAX_RECEIPT_BYTES,
      errorFactory: (message) => new WormBundleError(message),
    });
    requireCondition(
      current.text === receipts[key].text,
      `[assembly] ${key} receipt changed before assembly completed`,
    );
  }
}

async function loadProtocolPolicy() {
  const file = await readStableFile(
    PROTOCOL_POLICY_PATH,
    "protocol policy",
    MAX_TRUST_POLICY_BYTES,
  );
  return validateProtocolPolicy(
    parseJson(file.bytes, "protocol policy"),
  );
}

async function readCanonicalJsonFile(file, label, maxBytes) {
  const read = await readStableFile(file, label, maxBytes);
  const value = parseJson(read.bytes, label);
  auditJsonShape(value, label);
  requireCondition(
    read.bytes.equals(
      Buffer.from(`${canonicalJson(value)}\n`, "utf8"),
    ),
    `[file] ${label} must be canonical JSON plus one newline`,
  );
  return { ...read, value };
}

async function readStableFile(file, label, maxBytes) {
  requireCondition(
    typeof file === "string" &&
      file.length > 0 &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0,
    `[file] ${label} path or bound is invalid`,
  );
  const requested = resolve(file);
  const initial = await lstat(requested, { bigint: true }).catch(
    () => null,
  );
  requireCondition(
    initial?.isFile() &&
      !initial.isSymbolicLink() &&
      initial.nlink === 1n &&
      initial.size > 0n &&
      initial.size <= BigInt(maxBytes),
    `[file] ${label} must be a bounded regular single-link file`,
  );
  const handle = await open(
    requested,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    requireCondition(
      sameStableFileStat(initial, before),
      `[file] ${label} changed before reading`,
    );
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const final = await lstat(requested, { bigint: true }).catch(
      () => null,
    );
    const realPath = await realpath(requested).catch(() => null);
    requireCondition(
      sameStableFileStat(before, after) &&
        sameStableFileStat(before, final) &&
        bytes.length === Number(before.size) &&
        realPath !== null &&
        isSamePath(requested, realPath),
      `[file] ${label} changed while reading`,
    );
    return {
      bytes,
      realPath,
      snapshot: before,
    };
  } finally {
    await handle.close();
  }
}

async function revalidateStableFile(file, label) {
  const final = await lstat(file.realPath, { bigint: true }).catch(
    () => null,
  );
  const finalPath = await realpath(file.realPath).catch(() => null);
  requireCondition(
    sameStableFileStat(file.snapshot, final) &&
      finalPath === file.realPath,
    `[file] ${label} changed before operation completed`,
  );
}

function sameStableFileStat(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.isFile() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    right.nlink === 1n
  );
}

async function copyStableFile({
  source,
  destination,
  label,
  maxBytes,
  expectedBytes,
  expectedSha256,
}) {
  const sourcePath = resolve(source);
  const destinationPath = resolve(destination);
  const initial = await lstat(sourcePath, { bigint: true }).catch(
    () => null,
  );
  requireCondition(
    initial?.isFile() &&
      !initial.isSymbolicLink() &&
      initial.nlink === 1n &&
      initial.size > 0n &&
      initial.size <= BigInt(maxBytes) &&
      initial.size === BigInt(expectedBytes) &&
      !isSamePath(sourcePath, destinationPath),
    `[copy] ${label} source is invalid`,
  );
  const sourceHandle = await open(
    sourcePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let destinationHandle;
  try {
    const opened = await sourceHandle.stat({ bigint: true });
    const sourceRealPath = await realpath(sourcePath).catch(
      () => null,
    );
    requireCondition(
      sameStableFileStat(initial, opened) &&
        sourceRealPath !== null &&
        isSamePath(sourcePath, sourceRealPath),
      `[copy] ${label} changed before copy`,
    );
    destinationHandle = await open(
      destinationPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expectedBytes) {
      const wanted = Math.min(buffer.length, expectedBytes - offset);
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        wanted,
        offset,
      );
      requireCondition(
        bytesRead > 0,
        `[copy] ${label} ended before its declared length`,
      );
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        requireCondition(
          result.bytesWritten > 0,
          `[copy] ${label} destination write stalled`,
        );
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const trailing = await sourceHandle.read(extra, 0, 1, offset);
    requireCondition(
      trailing.bytesRead === 0,
      `[copy] ${label} exceeds its declared length`,
    );
    await destinationHandle.sync();
    const digest = hash.digest("hex");
    const after = await sourceHandle.stat({ bigint: true });
    const final = await lstat(sourcePath, { bigint: true }).catch(
      () => null,
    );
    requireCondition(
      sameStableFileStat(opened, after) &&
        sameStableFileStat(opened, final) &&
        digest === expectedSha256,
      `[copy] ${label} source digest or snapshot drifted`,
    );
    return { bytes: offset, sha256: digest };
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

async function writeCanonicalJsonExclusive(file, value) {
  rejectProhibitedFields(value, basename(file));
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(
    resolve(file),
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      requireCondition(
        result.bytesWritten > 0,
        `[file] ${basename(file)} write stalled`,
      );
      offset += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return bytes;
}

async function validateExactAssemblyLayout(directory) {
  const root = resolve(directory);
  await validateExactDirectory(
    root,
    [
      "evidence",
      "objects",
      "signing-request.json",
      "sources",
      "unsigned-manifest.json",
    ],
    new Set(["evidence", "objects", "sources"]),
    "assembly root",
  );
  await validateExactDirectory(
    join(root, "evidence"),
    REQUIRED_EVIDENCE_KINDS.map((kind) => `${kind}.json`),
    new Set(),
    "assembly evidence directory",
  );
  await validateExactDirectory(
    join(root, "objects"),
    Object.values(WORM_RETENTION_OBJECT_FILE_NAMES),
    new Set(),
    "assembly objects directory",
  );
  await validateExactDirectory(
    join(root, "sources"),
    ["authority-review.json", "receipts"],
    new Set(["receipts"]),
    "assembly sources directory",
  );
  await validateExactDirectory(
    join(root, "sources", "receipts"),
    WORM_RECEIPT_KEYS.map((key) => `${key}.json`),
    new Set(),
    "assembly receipt sources directory",
  );
  return root;
}

async function requireExactObjectDirectory(directory) {
  const root = resolve(directory);
  await validateExactDirectory(
    root,
    Object.values(WORM_RETENTION_OBJECT_FILE_NAMES),
    new Set(),
    "source objects directory",
  );
  return root;
}

async function validateExactDirectory(
  directory,
  expectedNames,
  expectedDirectories,
  label,
) {
  const stat = await lstat(directory, { bigint: true }).catch(
    () => null,
  );
  const directoryRealPath = await realpath(directory).catch(() => null);
  requireCondition(
    stat?.isDirectory() &&
      !stat.isSymbolicLink() &&
      directoryRealPath !== null &&
      isSamePath(directory, directoryRealPath),
    `[layout] ${label} must be a real directory`,
  );
  const entries = await readdir(directory, { withFileTypes: true });
  requireCondition(
    sameJson(
      entries.map((entry) => entry.name).sort(),
      [...expectedNames].sort(),
    ),
    `[layout] ${label} members drifted`,
  );
  for (const entry of entries) {
    const expectedDirectory = expectedDirectories.has(entry.name);
    requireCondition(
      !entry.isSymbolicLink() &&
        (expectedDirectory ? entry.isDirectory() : entry.isFile()),
      `[layout] ${label} entry type drifted`,
    );
    if (!expectedDirectory) {
      const child = await lstat(join(directory, entry.name), {
        bigint: true,
      });
      requireCondition(
        child.nlink === 1n,
        `[layout] ${label} contains a hard-linked file`,
      );
    }
  }
}

function requireFreshOutputPath(value) {
  requireCondition(
    typeof value === "string" && value.length > 0,
    "[output] output directory is required",
  );
  const output = resolve(value);
  const parsed = path.parse(output);
  requireCondition(
    output !== parsed.root &&
      basename(output) !== "." &&
      basename(output) !== "..",
    "[output] output directory is unsafe",
  );
  return output;
}

async function createOwnedOutputDirectory(output) {
  const parent = dirname(output);
  const parentBefore = await lstat(parent, { bigint: true }).catch(
    () => null,
  );
  const parentRealPath = await realpath(parent).catch(() => null);
  requireCondition(
    parentBefore?.isDirectory() &&
      !parentBefore.isSymbolicLink() &&
      parentRealPath !== null &&
      isSamePath(parent, parentRealPath),
    "[output] parent must be an existing real directory",
  );
  await mkdir(output, { mode: 0o700 });
  const ownership = await lstat(output, { bigint: true }).catch(
    () => null,
  );
  const outputRealPath = await realpath(output).catch(() => null);
  const parentAfter = await lstat(parent, { bigint: true }).catch(
    () => null,
  );
  requireCondition(
    ownership?.isDirectory() &&
      !ownership.isSymbolicLink() &&
      outputRealPath !== null &&
      isSamePath(output, outputRealPath) &&
      sameDirectoryIdentity(parentBefore, parentAfter),
    "[output] new directory identity is unsafe",
  );
  return ownership;
}

async function removeOwnedOutput(output, ownership) {
  const resolved = requireFreshOutputPath(output);
  const current = await lstat(resolved, { bigint: true }).catch(
    () => null,
  );
  const currentRealPath = await realpath(resolved).catch(() => null);
  requireCondition(
    sameDirectoryIdentity(ownership, current) &&
      currentRealPath !== null &&
      isSamePath(resolved, currentRealPath),
    "[output] refusing to remove a replaced output directory",
  );
  await rm(resolved, { recursive: true, force: true });
}

function sameDirectoryIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.isDirectory() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function isSameOrWithin(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`))
  );
}

function isSamePath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(resolve(value));
    return process.platform === "win32"
      ? normalized.toLowerCase()
      : normalized;
  };
  return normalize(left) === normalize(right);
}

function anchorMessage(policyId, subjectDigestSha256) {
  return Buffer.from(
    `${ANCHOR_DOMAIN}\n${policyId}\n${subjectDigestSha256}\n`,
    "utf8",
  );
}

function ceremonyApprovalMessage({
  role,
  keyId,
  protocolPolicySha256,
  trustPolicySha256,
  policyId,
  ceremonyId,
  subjectDigestSha256,
  signingRequestSha256,
}) {
  return Buffer.from(
    [
      WORM_CEREMONY_APPROVAL_DOMAIN,
      role,
      keyId,
      protocolPolicySha256,
      trustPolicySha256,
      policyId,
      ceremonyId,
      subjectDigestSha256,
      signingRequestSha256,
      "",
    ].join("\n"),
    "utf8",
  );
}

function decodeSingleLine(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WormBundleError(`[file] ${label} is not UTF-8`);
  }
  requireCondition(
    text.endsWith("\n") &&
      !text.endsWith("\r\n") &&
      text.indexOf("\n") === text.length - 1,
    `[file] ${label} must contain one LF-terminated line`,
  );
  return text.slice(0, -1);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new WormBundleError(`[json] ${label} is invalid UTF-8 JSON`);
  }
}

function auditJsonShape(value, label) {
  let nodes = 0;
  const visit = (entry, depth) => {
    nodes += 1;
    requireCondition(
      depth <= MAX_JSON_DEPTH && nodes <= MAX_JSON_NODES,
      `[json] ${label} exceeds complexity bounds`,
    );
    if (typeof entry === "string") {
      requireCondition(
        Buffer.byteLength(entry, "utf8") <= MAX_STRING_BYTES,
        `[json] ${label} contains an oversized string`,
      );
    } else if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
    } else if (entry !== null && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        requireCondition(
          Buffer.byteLength(key, "utf8") <= 256,
          `[json] ${label} contains an oversized key`,
        );
        visit(item, depth + 1);
      }
    } else {
      requireCondition(
        entry === null ||
          typeof entry === "boolean" ||
          typeof entry === "string" ||
          (typeof entry === "number" && Number.isFinite(entry)),
        `[json] ${label} contains an unsupported value`,
      );
    }
  };
  visit(value, 0);
}

function rejectProhibitedFields(value, label) {
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      requireCondition(
        !PROHIBITED_FIELD_NAMES.has(normalized),
        `[redaction] ${label} contains prohibited field ${key}`,
      );
      visit(item);
    }
  };
  visit(value);
}

function requireTimestamp(value, label) {
  requireCondition(
    typeof value === "string" && RFC3339_PATTERN.test(value),
    `[time] ${label} is not canonical RFC3339 UTC`,
  );
  const parsed = new Date(value);
  requireCondition(
    Number.isFinite(parsed.getTime()),
    `[time] ${label} is invalid`,
  );
  return parsed;
}

function requireDate(value, label) {
  requireCondition(
    value instanceof Date && Number.isFinite(value.getTime()),
    `[time] ${label} is invalid`,
  );
  return value;
}

function requireSha256(value, label) {
  requireCondition(
    SHA256_PATTERN.test(value),
    `[digest] ${label} is invalid`,
  );
  return value;
}

function stripSha256(value, label) {
  requireCondition(
    typeof value === "string" && value.startsWith("sha256:"),
    `[digest] ${label} is invalid`,
  );
  return requireSha256(value.slice(7), label);
}

function exactKeys(value, keys, label) {
  requireCondition(
    sameJson(Object.keys(requireObject(value, label)).sort(), [
      ...keys,
    ].sort()),
    `[schema] ${label} keys drifted`,
  );
}

function requireObject(value, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `[schema] ${label} must be an object`,
  );
  return value;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function requireCondition(condition, message) {
  if (!condition) throw new WormBundleError(message);
}
