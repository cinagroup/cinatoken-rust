import { afterEach, describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import { Readable } from "node:stream";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WORM_AUTHORITY_REVIEW_CONTRACT,
  assembleWormBundle,
  finalizeWormBundle,
  signWormAnchor,
  writeApprovalReceiptExclusive,
} from "../tools/lib/container_runtime_worm_bundle.mjs";
import {
  WORM_OBJECTS,
  collectIndependentReadback,
  normalizePublishPredecessors,
  normalizeReadbackPredecessor,
  publishCreateOnlyObjects,
} from "../tools/lib/container_runtime_worm_data.mjs";
import {
  collectEnforcementProbes,
  collectFinalLockReadback,
  collectPostProbeReadback,
  normalizeFinalLockPredecessors,
  normalizePostReadbackReceipt,
  normalizeProbePredecessors,
  normalizeProbeReceipt,
  normalizePublisherRevokeReceipt,
  normalizePublisherVerifyReceipt,
  revokePublisher,
  verifyPublisherRevocation,
} from "../tools/lib/container_runtime_worm_enforcement.mjs";
import { canonicalJson } from "../tools/lib/container_runtime_worm_staging.mjs";
import {
  MANIFEST_CONTRACT,
  PROTOCOL_POLICY_CONTRACT,
  REQUIRED_APPROVAL_ROLES,
  REQUIRED_AUTHORITY_PROFILES,
  REQUIRED_OBJECT_KINDS,
  TRUST_POLICY_CONTRACT,
  WORM_RETENTION_OBJECT_FILE_NAMES,
  validateRetainedZipPacket,
} from "../tools/verify_container_runtime_worm_retention.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const BUCKET_NAME = "cinatoken-worm-staging";
const COMMIT = "a".repeat(40);
const CEREMONY_ID = "123e4567-e89b-42d3-a456-426614174001";
const EXPIRY = "2026-07-28T02:30:00.000Z";
const NOW = new Date("2026-07-28T02:00:00.000Z");
const SOURCE_RUN_ID = 30236225467;
const SIGNER_RUN_ID = 30236329194;
const SIGSTORE_BUNDLE_MEDIA_TYPE =
  "application/vnd.dev.sigstore.bundle.v0.3+json";
const DSSE_PAYLOAD_TYPE =
  "application/vnd.in-toto+json";

const IDS = Object.freeze({
  publisher: "publisher-access-key-bundle-test",
  lockOperator: "d".repeat(32),
  objectVerifier: "object-verifier-access-key-bundle-test",
  lockVerifier: "e".repeat(32),
  lifecycleOperator: "f".repeat(32),
  lifecycleVerifier: "1".repeat(32),
});

const SUBJECT_DIGESTS = Object.freeze({
  archiveSha256: "1".repeat(64),
  ociIndexSha256: "2".repeat(64),
  ociManifestSha256: "3".repeat(64),
  ociConfigSha256: "4".repeat(64),
  runtimeBinarySha256: "5".repeat(64),
  sbomSha256: "6".repeat(64),
  vulnerabilityScanSha256: "7".repeat(64),
});

const temporaryRoots = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("container runtime WORM bundle assembly and signing", () => {
  test("assembles B1-B5, binds two roots, and finalizes through verifier v2", async () => {
    const fixture = await createCeremonyFixture();
    const assembly = await assembleWormBundle(fixture.assemblyOptions);
    expect(assembly.status).toBe("assembled");
    expect(assembly.approvalsComplete).toBe(false);
    expect(assembly.wormRetentionVerified).toBe(false);

    const approvalPaths = {};
    for (const role of REQUIRED_APPROVAL_ROLES) {
      const key = fixture.keys.find((entry) => entry.role === role);
      const approval = await signWormAnchor({
        assemblyDirectory: fixture.assemblyRoot,
        trustPolicyPath: fixture.trustPolicyPath,
        role,
        keyId: key.keyId,
        privateKeyBytes: fixture.keyPairs
          .get(key.keyId)
          .privateKey.export({ format: "pem", type: "pkcs8" }),
        now: NOW,
      });
      const approvalPath = join(fixture.root, `${role}-approval.json`);
      await writeApprovalReceiptExclusive(approvalPath, approval);
      approvalPaths[role] = approvalPath;
      expect(approval.ceremonySignatureBase64Url).toHaveLength(86);
    }

    const decisionPath = join(fixture.root, "decision-report.json");
    const report = await finalizeWormBundle({
      assemblyDirectory: fixture.assemblyRoot,
      trustPolicyPath: fixture.trustPolicyPath,
      approvalPaths,
      outputDirectory: fixture.finalRoot,
      decisionOutputPath: decisionPath,
      now: NOW,
    });
    expect(report.status).toBe("passed");
    expect(report.wormRetentionVerified).toBe(true);
    expect(report.s3Complete).toBe(true);
    expect(report.localReplayVerified).toBe(true);
    expect(report.externalDecisionReportRequired).toBe(true);
    expect(report.productionCutoverAuthorized).toBe(false);
    expect(JSON.parse(await readFile(decisionPath, "utf8"))).toEqual(
      report,
    );
    expect(
      (await readdirNames(fixture.finalRoot)).sort(),
    ).toEqual(["evidence", "manifest.json", "objects"]);
  }, 30_000);

  test("rejects a changed source receipt before signing", async () => {
    const fixture = await createCeremonyFixture();
    await assembleWormBundle(fixture.assemblyOptions);
    const sourcePath = join(
      fixture.assemblyRoot,
      "sources",
      "receipts",
      "probe.json",
    );
    const value = JSON.parse(await readFile(sourcePath, "utf8"));
    value.capturedAt = "2026-07-28T01:36:07.000Z";
    await writeFile(sourcePath, `${canonicalJson(value)}\n`);
    const key = fixture.keys.find(
      (entry) => entry.role === "operations",
    );
    await expect(
      signWormAnchor({
        assemblyDirectory: fixture.assemblyRoot,
        trustPolicyPath: fixture.trustPolicyPath,
        role: "operations",
        keyId: key.keyId,
        privateKeyBytes: fixture.keyPairs
          .get(key.keyId)
          .privateKey.export({ format: "pem", type: "pkcs8" }),
        now: NOW,
      }),
    ).rejects.toThrow(/inventory digest drifted/i);
  }, 30_000);

  test("rejects a private key from the other approval root", async () => {
    const fixture = await createCeremonyFixture();
    await assembleWormBundle(fixture.assemblyOptions);
    const operations = fixture.keys.find(
      (entry) => entry.role === "operations",
    );
    const security = fixture.keys.find(
      (entry) => entry.role === "security",
    );
    await expect(
      signWormAnchor({
        assemblyDirectory: fixture.assemblyRoot,
        trustPolicyPath: fixture.trustPolicyPath,
        role: "operations",
        keyId: operations.keyId,
        privateKeyBytes: fixture.keyPairs
          .get(security.keyId)
          .privateKey.export({ format: "pem", type: "pkcs8" }),
        now: NOW,
      }),
    ).rejects.toThrow(/does not match/i);
  }, 30_000);

  test("production CLIs expose no historical finalization clock or key path", () => {
    const root = join(import.meta.dir, "..");
    const describe = (script) =>
      Bun.spawnSync({
        cmd: ["node", join(root, "tools", script), "--describe"],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
    const assembler = describe(
      "assemble_container_runtime_worm_bundle.mjs",
    );
    const signer = describe(
      "sign_container_runtime_worm_anchor.mjs",
    );
    const finalizer = describe(
      "finalize_container_runtime_worm_bundle.mjs",
    );
    expect(assembler.exitCode).toBe(0);
    expect(signer.exitCode).toBe(0);
    expect(finalizer.exitCode).toBe(0);
    expect(JSON.parse(signer.stdout).privateKeyInput).toBe("stdin-only");
    expect(JSON.parse(finalizer.stdout).acceptsHistoricalTimeOverride).toBe(
      false,
    );
    expect(JSON.parse(finalizer.stdout).externalDecisionOutput).toBe(
      "required-new-file",
    );

    const rejected = Bun.spawnSync({
      cmd: [
        "node",
        join(root, "tools", "sign_container_runtime_worm_anchor.mjs"),
        "--private-key-path",
        "forbidden.pem",
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr.toString()).toContain("unknown option");

    const historicalTime = Bun.spawnSync({
      cmd: [
        "node",
        join(root, "tools", "finalize_container_runtime_worm_bundle.mjs"),
        "--now",
        NOW.toISOString(),
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(historicalTime.exitCode).toBe(2);
    expect(historicalTime.stderr.toString()).toContain("unknown option");

    const missingDecision = Bun.spawnSync({
      cmd: [
        "node",
        join(root, "tools", "finalize_container_runtime_worm_bundle.mjs"),
        "--assembly",
        "assembly",
        "--trust-policy",
        "trust.json",
        "--operations-approval",
        "operations.json",
        "--security-approval",
        "security.json",
        "--output",
        "bundle",
      ],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missingDecision.exitCode).toBe(2);
    expect(missingDecision.stderr.toString()).toContain(
      "--decision-output is required",
    );
  });

  test("retained packet parser rejects fake ZIP and traversal entries", () => {
    expect(() =>
      validateRetainedZipPacket(
        Buffer.from("not-a-zip", "utf8"),
        "packet",
      ),
    ).toThrow(/ZIP/i);
    expect(() =>
      validateRetainedZipPacket(minimalZip("../escape"), "packet"),
    ).toThrow(/unsafe|duplicated/i);
    const localMethodDrift = minimalZip("packet.json");
    localMethodDrift.writeUInt16LE(8, 8);
    expect(() =>
      validateRetainedZipPacket(localMethodDrift, "packet"),
    ).toThrow(/local header identity|local size|boundary/i);
  });
});

async function createCeremonyFixture() {
  const root = await mkdtemp(join(tmpdir(), "cinatoken-worm-bundle-"));
  temporaryRoots.push(root);
  const receiptsRoot = join(root, "receipts");
  const objectsRoot = join(root, "readback-objects");
  const assemblyRoot = join(root, "assembly");
  const finalRoot = join(root, "final");
  await mkdir(receiptsRoot);
  await mkdir(objectsRoot);

  const protocol = JSON.parse(
    await readFile(
      join(
        import.meta.dir,
        "..",
        "config",
        "container-runtime-worm-retention-policy.json",
      ),
      "utf8",
    ),
  );
  expect(protocol.contract).toBe(PROTOCOL_POLICY_CONTRACT);
  const objectBytes = retainedObjectBytes(protocol);
  const statementSha256 = sha256(
    objectBytes.get("provenance-statement"),
  );
  const prefix = `${protocol.prefixRoot}${statementSha256}/`;
  const target = {
    accountIdSha256: sha256(ACCOUNT_ID),
    bucketName: BUCKET_NAME,
    jurisdiction: "default",
    prefix,
    statementSha256,
  };

  const baseline = baselineReceipt(target);
  const lock = lockReceipt(target, protocol);
  const lockRevoke = lockRevokeReceipt(target, lock);
  const lockVerify = lockVerifyReceipt(
    target,
    lock,
    lockRevoke,
  );
  const publishTarget = normalizePublishPredecessors({
    accountId: ACCOUNT_ID,
    baselineReceipt: baseline,
    baselineReceiptText: canonicalText(baseline),
    lockRevocationReceipt: lockVerify,
    lockRevocationReceiptText: canonicalText(lockVerify),
  });
  const publish = await publishCreateOnlyObjects({
    target: publishTarget,
    artifacts: artifactDescriptors(objectBytes),
    credentials: {
      accessKeyId: IDS.publisher,
      secretAccessKey: "publisher-secret-bundle-test",
      credentialIdSha256: sha256(IDS.publisher),
    },
    commitSha: COMMIT,
    s3: publishAdapter(),
    now: sequenceNow(
      REQUIRED_OBJECT_KINDS.map(
        (_, index) =>
          `2026-07-28T01:34:0${index}.000Z`,
      ),
    ),
  });
  const readbackTarget = normalizeReadbackPredecessor({
    accountId: ACCOUNT_ID,
    publishReceipt: publish,
    publishReceiptText: canonicalText(publish),
  });
  const objectReadback = await collectIndependentReadback({
    target: readbackTarget,
    credentials: {
      accessKeyId: IDS.objectVerifier,
      secretAccessKey: "object-verifier-secret-bundle-test",
      credentialIdSha256: sha256(IDS.objectVerifier),
    },
    s3: readbackAdapter(readbackTarget, objectBytes),
    sink: fileSink(objectsRoot),
    now: sequenceNow(
      REQUIRED_OBJECT_KINDS.map(
        (_, index) =>
          `2026-07-28T01:35:0${index}.000Z`,
      ),
    ),
  });

  let enforcementTarget = normalizeProbePredecessors({
    accountId: ACCOUNT_ID,
    policy: protocol,
    publishReceipt: publish,
    publishReceiptText: canonicalText(publish),
    readbackReceipt: objectReadback,
    readbackReceiptText: canonicalText(objectReadback),
    lockRevocationReceipt: lockVerify,
    lockRevocationReceiptText: canonicalText(lockVerify),
  });
  const probe = await collectEnforcementProbes({
    target: enforcementTarget,
    credentials: {
      accessKeyId: IDS.publisher,
      secretAccessKey: "publisher-secret-bundle-test",
      credentialIdSha256: sha256(IDS.publisher),
    },
    probe: probeAdapter(),
    now: sequenceNow([
      "2026-07-28T01:36:00.000Z",
      "2026-07-28T01:36:01.000Z",
      "2026-07-28T01:36:02.000Z",
      "2026-07-28T01:36:03.000Z",
      "2026-07-28T01:36:04.000Z",
      "2026-07-28T01:36:05.000Z",
      "2026-07-28T01:36:06.000Z",
    ]),
  });
  enforcementTarget = normalizeProbeReceipt({
    target: enforcementTarget,
    receipt: probe,
    receiptText: canonicalText(probe),
  });
  const publisherRevoke = await revokePublisher({
    target: enforcementTarget,
    credentials: {
      apiToken: "lifecycle-operator-secret-bundle-test",
      targetTokenId: IDS.publisher,
    },
    lifecycle: publisherLifecycleAdapter(),
    now: sequenceNow([
      "2026-07-28T01:37:00.000Z",
      "2026-07-28T01:37:10.000Z",
      "2026-07-28T01:37:20.000Z",
    ]),
  });
  enforcementTarget = normalizePublisherRevokeReceipt({
    target: enforcementTarget,
    receipt: publisherRevoke,
    receiptText: canonicalText(publisherRevoke),
  });
  const publisherVerify = await verifyPublisherRevocation({
    target: enforcementTarget,
    credentials: {
      apiToken: "lifecycle-verifier-secret-bundle-test",
      targetTokenId: IDS.publisher,
    },
    lifecycle: publisherLifecycleAdapter(),
    now: sequenceNow([
      "2026-07-28T01:38:00.000Z",
      "2026-07-28T01:38:10.000Z",
    ]),
  });
  enforcementTarget = normalizePublisherVerifyReceipt({
    target: enforcementTarget,
    receipt: publisherVerify,
    receiptText: canonicalText(publisherVerify),
  });
  const postReadback = await collectPostProbeReadback({
    target: enforcementTarget,
    credentials: {
      accessKeyId: IDS.objectVerifier,
      secretAccessKey: "object-verifier-secret-bundle-test",
      credentialIdSha256: sha256(IDS.objectVerifier),
    },
    s3: postReadbackAdapter(
      enforcementTarget.probeObject,
      objectBytes.get("provenance-evidence-packet"),
    ),
    now: () => new Date("2026-07-28T01:39:00.000Z"),
  });
  enforcementTarget = normalizePostReadbackReceipt({
    target: enforcementTarget,
    receipt: postReadback,
    receiptText: canonicalText(postReadback),
  });
  enforcementTarget = normalizeFinalLockPredecessors({
    target: enforcementTarget,
    lockReceipt: lock,
    lockReceiptText: canonicalText(lock),
  });
  const finalLock = await collectFinalLockReadback({
    target: enforcementTarget,
    credentials: {
      apiToken: "lock-verifier-secret-bundle-test",
    },
    lockApi: finalLockAdapter(enforcementTarget),
    now: sequenceNow([
      "2026-07-28T01:40:00.000Z",
      "2026-07-28T01:40:10.000Z",
    ]),
  });

  const receipts = {
    baseline,
    lock,
    lockRevoke,
    lockVerify,
    publish,
    objectReadback,
    probe,
    publisherRevoke,
    publisherVerify,
    postReadback,
    finalLock,
  };
  const receiptPaths = {};
  for (const [key, value] of Object.entries(receipts)) {
    const file = join(receiptsRoot, `${key}.json`);
    await writeFile(file, canonicalText(value));
    receiptPaths[key] = file;
  }
  for (const definition of WORM_OBJECTS) {
    await writeFile(
      join(objectsRoot, definition.fileName),
      objectBytes.get(definition.kind),
      { flag: "wx" },
    ).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }

  const accountIdPath = join(root, "account-id.txt");
  await writeFile(accountIdPath, `${ACCOUNT_ID}\n`);
  const { trustPolicy, keys, keyPairs } = trustPolicyFixture(
    protocol,
    target,
  );
  const trustPolicyPath = join(root, "trust-policy.json");
  await writeFile(
    trustPolicyPath,
    `${canonicalJson(trustPolicy)}\n`,
  );
  const review = authorityReview(target);
  const authorityReviewPath = join(root, "authority-review.json");
  await writeFile(
    authorityReviewPath,
    `${canonicalJson(review)}\n`,
  );

  return {
    root,
    assemblyRoot,
    finalRoot,
    trustPolicyPath,
    keys,
    keyPairs,
    assemblyOptions: {
      accountIdFile: accountIdPath,
      trustPolicyPath,
      authorityReviewPath,
      objectsDirectory: objectsRoot,
      outputDirectory: assemblyRoot,
      receipts: receiptPaths,
      now: NOW,
    },
  };
}

function baselineReceipt(target) {
  return {
    schemaVersion: 2,
    contract:
      "cinatoken-container-runtime-worm-staging-phase-receipt-v2",
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "baseline",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-28T01:30:00.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target,
    credential: {
      role: "publisher",
      credentialType: "r2-object-read-write-api-token",
      credentialIdSha256: sha256(IDS.publisher),
    },
    facts: {
      baselineObservedAt: "2026-07-28T01:30:00.000Z",
      baselinePaginationComplete: true,
      preexistingObjectCount: 0,
      multipartUploadCount: 0,
      objectPages: 1,
      multipartPages: 1,
      providerRequestIdsComplete: true,
    },
    providerOperations: [
      {
        operation: "ListObjectsV2",
        page: 1,
        httpStatus: 200,
        providerRequestId: "baseline-objects-request",
      },
      {
        operation: "ListMultipartUploads",
        page: 1,
        httpStatus: 200,
        providerRequestId: "baseline-multipart-request",
      },
    ],
    limits: stagingLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

function lockReceipt(target, protocol) {
  const selectedRuleId = `cinatoken-s3-${target.statementSha256.slice(0, 24)}`;
  return {
    schemaVersion: 2,
    contract:
      "cinatoken-container-runtime-worm-staging-phase-receipt-v2",
    source: "cinatoken-container-runtime-worm-staging-collector",
    environment: "staging",
    phase: "lock",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-28T01:31:20.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: true,
    mutationPerformed: true,
    target,
    credential: {
      role: "lock-operator",
      credentialType: "cloudflare-r2-admin-read-write-api-token",
      credentialIdSha256: sha256(IDS.lockOperator),
      selfVerifiedAt: "2026-07-28T01:31:00.000Z",
      expiresAt: EXPIRY,
      remainingLifetimeSeconds: 3_540,
    },
    facts: {
      mechanism: "cloudflare-r2-bucket-lock-api",
      awsS3ObjectLockHeadersUsed: false,
      configuredAt: "2026-07-28T01:31:10.000Z",
      configurationRequestId: "lock-configure-request",
      observedAt: "2026-07-28T01:31:20.000Z",
      readbackRequestId: "lock-after-request",
      httpStatus: 200,
      selectedRuleId,
      rules: [
        {
          id: selectedRuleId,
          condition: {
            type: "Age",
            maxAgeSeconds: protocol.lockRetentionSeconds,
          },
          enabled: true,
          prefix: target.prefix,
        },
      ],
      preconfigurationRequestId: "lock-before-request",
      preexistingRuleCount: 0,
      unrelatedRulesPreserved: true,
    },
    providerOperations: [
      stagingOperation("credential-preflight", "lock-credential-request"),
      stagingOperation("lock-before", "lock-before-request"),
      {
        ...stagingOperation("lock-configure", "lock-configure-request"),
        method: "PUT",
      },
      stagingOperation("lock-after", "lock-after-request"),
    ],
    limits: stagingLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

function lockRevokeReceipt(target, lock) {
  const lockReceiptSha256 = sha256(canonicalText(lock));
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-worm-lock-revocation-phase-receipt-v1",
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
    environment: "staging",
    phase: "revoke",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-28T01:32:20.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: true,
    mutationPerformed: true,
    target: {
      ...target,
      targetRole: "lock-operator",
      targetCredentialIdSha256: sha256(IDS.lockOperator),
      lockReceiptSha256,
      lockCapturedAt: lock.capturedAt,
    },
    authority: lifecycleAuthority(
      "lifecycle-operator",
      "cloudflare-account-api-token-read-edit",
      IDS.lifecycleOperator,
      "2026-07-28T01:32:00.000Z",
      3_480,
    ),
    facts: {
      apiSurface: "cloudflare-account-token-api",
      deletedAt: "2026-07-28T01:32:10.000Z",
      deletionHttpStatus: 200,
      deletionRequestId: "lock-delete-request",
      deletionResultIdSha256: sha256(IDS.lockOperator),
      operatorReadbackAt: "2026-07-28T01:32:20.000Z",
      operatorReadbackErrorCodes: [1000],
      operatorReadbackHttpStatus: 404,
      operatorReadbackRequestId: "lock-operator-absence-request",
      operatorReadbackResponseBodySha256: sha256(
        "lock-operator-absence-body",
      ),
      targetAbsentAfterDelete: true,
    },
    providerOperations: [
      lifecycleOperation(
        "GET",
        "lifecycle-operator-preflight",
        200,
        "lock-lifecycle-operator-preflight",
      ),
      lifecycleOperation(
        "DELETE",
        "lock-operator-delete",
        200,
        "lock-delete-request",
      ),
      lifecycleOperation(
        "GET",
        "operator-revocation-readback",
        404,
        "lock-operator-absence-request",
        sha256("lock-operator-absence-body"),
      ),
    ],
    limits: lifecycleLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

function lockVerifyReceipt(target, lock, revoke) {
  const revokeReceiptSha256 = sha256(canonicalText(revoke));
  return {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-worm-lock-revocation-phase-receipt-v1",
    source: "cinatoken-container-runtime-worm-lifecycle-collector",
    environment: "staging",
    phase: "verify",
    mode: "live",
    ok: true,
    capturedAt: "2026-07-28T01:33:10.000Z",
    networkRequests: true,
    credentialsRead: true,
    writesFiles: false,
    phaseMutationConfirmed: false,
    mutationPerformed: false,
    target: {
      ...revoke.target,
      revokeReceiptSha256,
      revokeCapturedAt: revoke.capturedAt,
      lifecycleOperatorCredentialIdSha256:
        sha256(IDS.lifecycleOperator),
      operatorReadbackErrorCodes: [1000],
    },
    authority: lifecycleAuthority(
      "lifecycle-verifier",
      "cloudflare-account-api-token-read",
      IDS.lifecycleVerifier,
      "2026-07-28T01:33:00.000Z",
      3_420,
    ),
    facts: {
      apiSurface: "cloudflare-account-token-api",
      independentReadbackAt: "2026-07-28T01:33:10.000Z",
      independentReadbackErrorCodes: [1000],
      independentReadbackHttpStatus: 404,
      independentReadbackRequestId: "lock-independent-absence-request",
      independentReadbackResponseBodySha256: sha256(
        "lock-independent-absence-body",
      ),
      operatorAndVerifierCredentialIdsDistinct: true,
      targetAbsenceIndependentlyObserved: true,
    },
    providerOperations: [
      lifecycleOperation(
        "GET",
        "lifecycle-verifier-preflight",
        200,
        "lock-lifecycle-verifier-preflight",
      ),
      lifecycleOperation(
        "GET",
        "independent-revocation-readback",
        404,
        "lock-independent-absence-request",
        sha256("lock-independent-absence-body"),
      ),
    ],
    limits: lifecycleLimits(),
    downstreamAuthority: downstreamAuthority(),
  };
}

function retainedObjectBytes(protocol) {
  const statement = statementFixture(protocol);
  const statementBytes = Buffer.from(canonicalJson(statement), "utf8");
  const bundle = bundleFixture(statementBytes);
  const bundleBytes = Buffer.from(canonicalJson(bundle), "utf8");
  const cosignLogBytes = Buffer.from("Verified OK\n", "utf8");
  const report = provenanceReportFixture({
    protocol,
    statementBytes,
    bundleBytes,
    cosignLogBytes,
  });
  return new Map([
    [
      "source-evidence-packet",
      minimalZip("source-evidence.txt"),
    ],
    [
      "provenance-evidence-packet",
      minimalZip("provenance-evidence.txt"),
    ],
    ["provenance-statement", statementBytes],
    ["sigstore-bundle", bundleBytes],
    [
      "provenance-report",
      Buffer.from(canonicalJson(report), "utf8"),
    ],
    ["cosign-verification-log", cosignLogBytes],
  ]);
}

function statementFixture(protocol) {
  const subjects = [
    ["container-runtime.oci.tar", SUBJECT_DIGESTS.archiveSha256],
    [
      "container-runtime.oci.index.json",
      SUBJECT_DIGESTS.ociIndexSha256,
    ],
    [
      "container-runtime.oci.manifest.json",
      SUBJECT_DIGESTS.ociManifestSha256,
    ],
    [
      "container-runtime.oci.config.json",
      SUBJECT_DIGESTS.ociConfigSha256,
    ],
    [
      "usr/local/bin/cinatoken-container-runtime",
      SUBJECT_DIGESTS.runtimeBinarySha256,
    ],
    [
      "container-runtime.sbom.syft.json",
      SUBJECT_DIGESTS.sbomSha256,
    ],
    [
      "container-runtime.vulnerabilities.grype.json",
      SUBJECT_DIGESTS.vulnerabilityScanSha256,
    ],
  ];
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/cinagroup/cinatoken-rust/blob/main/docs/container-runtime-provenance-build-type-v1.md",
        externalParameters: {
          repository: protocol.repository,
          ref: "refs/heads/main",
          eventName: "push",
        },
        internalParameters: {},
        resolvedDependencies: [],
      },
      runDetails: {
        builder: { id: protocol.provenanceBuilderId },
        byproducts: [],
        metadata: {
          invocationId: `https://github.com/${protocol.repository}/actions/runs/${SOURCE_RUN_ID}/attempts/1`,
        },
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: subjects.map(([name, digest]) => ({
      digest: { sha256: digest },
      name,
    })),
  };
}

function bundleFixture(statementBytes) {
  const base64 = (length, fill) =>
    Buffer.alloc(length, fill).toString("base64");
  return {
    mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    verificationMaterial: {
      certificate: { rawBytes: base64(512, 1) },
      tlogEntries: [
        {
          logIndex: "2256863846",
          logId: { keyId: base64(32, 2) },
          kindVersion: { kind: "dsse", version: "0.0.1" },
          integratedTime: "1785125402",
          inclusionPromise: {
            signedEntryTimestamp: base64(64, 3),
          },
          inclusionProof: {
            logIndex: "2256863846",
            rootHash: base64(32, 4),
            treeSize: "2256863850",
            hashes: [base64(32, 5)],
            checkpoint: { envelope: "rekor checkpoint" },
          },
          canonicalizedBody: base64(128, 6),
        },
      ],
      timestampVerificationData: {
        rfc3161Timestamps: [
          { signedTimestamp: base64(256, 7) },
        ],
      },
    },
    dsseEnvelope: {
      payload: statementBytes.toString("base64"),
      payloadType: DSSE_PAYLOAD_TYPE,
      signatures: [{ sig: base64(64, 8) }],
    },
  };
}

function provenanceReportFixture({
  protocol,
  statementBytes,
  bundleBytes,
  cosignLogBytes,
}) {
  const statementSha256 = sha256(statementBytes);
  const bundleSha256 = sha256(bundleBytes);
  return {
    artifactAttestationVerified: true,
    canonicalContainerImageDigest: null,
    cloudflareDeploymentDigestVerified: false,
    contractVersion: 1,
    customerTrafficAuthorized: false,
    decision: {
      formalP5Evidence: false,
      immutableRetentionDecision: "not-verified",
      productionDecision: "not-authorized",
      s3CryptographicEvidence: true,
      s3Decision: "cryptographic-subgate-passed-worm-pending",
      scope: "github-sigstore-provenance-only",
    },
    generatedProvenancePresent: true,
    githubArtifactRetentionDays: 90,
    imageSignatureVerified: false,
    p5Eligible: false,
    productionCutoverAuthorized: false,
    registryDigestAuthorized: false,
    registryReadbackVerified: false,
    remoteMutationAuthorized: false,
    reportKind: "container-runtime-provenance-verification",
    s3Complete: false,
    signatureVerificationPerformed: true,
    signedTimestampVerified: true,
    signer: {
      certificateIdentity: protocol.provenanceCertificateIdentity,
      certificateOidcIssuer: protocol.provenanceOidcIssuer,
      commit: COMMIT,
      cosignLinuxAmd64Sha256: protocol.cosignLinuxAmd64Sha256,
      cosignVersion: protocol.cosignVersion,
      runAttempt: 1,
      runId: SIGNER_RUN_ID,
      workflow: protocol.provenanceWorkflow,
    },
    sigstore: {
      bundleBytes: bundleBytes.length,
      bundleMediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
      bundleSha256,
      certificateIdentityVerified: true,
      certificateOidcIssuerVerified: true,
      certificateTransparencySctVerified: true,
      cosignVerificationLogBytes: cosignLogBytes.length,
      cosignVerificationLogSha256: sha256(cosignLogBytes),
      dssePayloadSha256: statementSha256,
      githubWorkflowClaimsVerified: true,
      inclusionPromisePresent: true,
      inclusionProofPresent: true,
      signatureCount: 1,
      signedTimestampCount: 1,
      signedTimestampVerified: true,
      transparencyIntegratedTime: "1785125402",
      transparencyLogIndex: "2256863846",
      transparencyLogVerified: true,
    },
    source: {
      commit: COMMIT,
      event: "push",
      ref: "refs/heads/main",
      repository: protocol.repository,
      runAttempt: 1,
      runId: SOURCE_RUN_ID,
      workflow: protocol.sourceWorkflow,
    },
    statement: {
      buildType:
        "https://github.com/cinagroup/cinatoken-rust/blob/main/docs/container-runtime-provenance-build-type-v1.md",
      bytes: statementBytes.length,
      canonicalJson: true,
      exactByproductBindingVerified: true,
      exactSubjectBindingVerified: true,
      predicateType: "https://slsa.dev/provenance/v1",
      sha256: statementSha256,
      type: "https://in-toto.io/Statement/v1",
    },
    status: "passed",
    subject: {
      archiveSha256: SUBJECT_DIGESTS.archiveSha256,
      ociConfigDigest: `sha256:${SUBJECT_DIGESTS.ociConfigSha256}`,
      ociIndexDigest: `sha256:${SUBJECT_DIGESTS.ociIndexSha256}`,
      ociManifestDigest: `sha256:${SUBJECT_DIGESTS.ociManifestSha256}`,
      runtimeBinarySha256: SUBJECT_DIGESTS.runtimeBinarySha256,
      sbomSha256: SUBJECT_DIGESTS.sbomSha256,
      vulnerabilityScanSha256:
        SUBJECT_DIGESTS.vulnerabilityScanSha256,
    },
    transparencyLogVerified: true,
    wormRetentionVerified: false,
  };
}

function artifactDescriptors(objectBytes) {
  return WORM_OBJECTS.map((definition) => {
    const bytes = objectBytes.get(definition.kind);
    return {
      ...definition,
      bytes: bytes.length,
      sha256: sha256(bytes),
      contentMd5Base64: createHash("md5")
        .update(bytes)
        .digest("base64"),
      bodyFactory: () => Readable.from([bytes]),
    };
  });
}

function publishAdapter() {
  let index = 0;
  return {
    async putObject() {
      const current = index++;
      return {
        ETag: `"bundle-etag-${current}"`,
        $metadata: {
          httpStatusCode: 200,
          requestId: `publish-request-${current}`,
        },
      };
    },
  };
}

function readbackAdapter(target, objectBytes) {
  let getIndex = 0;
  return {
    async listObjectsV2() {
      return {
        Name: target.bucketName,
        Prefix: target.prefix,
        KeyCount: target.objects.length,
        Contents: target.objects.map((entry) => ({
          Key: entry.key,
          Size: entry.bytes,
          ETag: entry.etag,
        })),
        IsTruncated: false,
        $metadata: {
          httpStatusCode: 200,
          requestId: "readback-list-objects",
        },
      };
    },
    async listMultipartUploads() {
      return {
        Bucket: target.bucketName,
        Prefix: target.prefix,
        Uploads: [],
        IsTruncated: false,
        $metadata: {
          httpStatusCode: 200,
          requestId: "readback-list-multipart",
        },
      };
    },
    async getObject(input) {
      const object = target.objects.find(
        (entry) => entry.key === input.Key,
      );
      const current = getIndex++;
      return {
        Body: Readable.from([objectBytes.get(object.kind)]),
        ContentLength: object.bytes,
        ContentType: object.contentType,
        ETag: object.etag,
        Metadata: {
          contract: MANIFEST_CONTRACT,
          repositorycommit: COMMIT,
          sha256: object.sha256,
        },
        $metadata: {
          httpStatusCode: 200,
          requestId: `readback-get-${current}`,
        },
      };
    },
  };
}

function fileSink(root) {
  return {
    async beginObject(object) {
      const chunks = [];
      return {
        async write(chunk) {
          chunks.push(Buffer.from(chunk));
        },
        async commit() {
          await writeFile(
            join(root, WORM_RETENTION_OBJECT_FILE_NAMES[object.kind]),
            Buffer.concat(chunks),
            { flag: "wx" },
          );
        },
        async abort() {
          chunks.length = 0;
        },
      };
    },
  };
}

function probeAdapter() {
  const responses = [
    probeResponse(412, "PreconditionFailed", "probe-preflight-request"),
    probeResponse(403, "AccessDenied", "probe-overwrite-request"),
    probeResponse(403, "AccessDenied", "probe-delete-request"),
  ];
  return {
    async putObject() {
      return responses.shift();
    },
    async deleteObject() {
      return responses.shift();
    },
  };
}

function probeResponse(httpStatus, errorCode, providerRequestId) {
  return {
    transportCompleted: true,
    timedOut: false,
    clientSideOnly: false,
    providerRejected: true,
    httpStatus,
    errorCode,
    providerRequestId,
    requestIdSource: "cf-ray",
    responseContentType: "application/xml",
    responseBytes: 64,
    responseBodySha256: sha256(`${providerRequestId}-body`),
  };
}

function publisherLifecycleAdapter() {
  return {
    async verifySelf({ role }) {
      const operator = role === "lifecycle-operator";
      return {
        httpStatus: 200,
        providerRequestId: operator
          ? "publisher-lifecycle-operator-preflight"
          : "publisher-lifecycle-verifier-preflight",
        responseBodySha256: sha256(`${role}-publisher-preflight`),
        credentialId: operator
          ? IDS.lifecycleOperator
          : IDS.lifecycleVerifier,
        status: "active",
        expiresAt: EXPIRY,
        notBefore: "2026-07-28T01:00:00.000Z",
      };
    },
    async deleteToken({ targetTokenId }) {
      return {
        httpStatus: 200,
        providerRequestId: "publisher-delete-request",
        responseBodySha256: sha256("publisher-delete-body"),
        resultId: targetTokenId,
      };
    },
    async readToken({ role }) {
      const independent = role === "lifecycle-verifier";
      return {
        httpStatus: 404,
        providerRequestId: independent
          ? "publisher-independent-absence-request"
          : "publisher-operator-absence-request",
        responseBodySha256: sha256(
          independent
            ? "publisher-independent-absence-body"
            : "publisher-operator-absence-body",
        ),
        errorCodes: [1000],
      };
    },
  };
}

function postReadbackAdapter(object, bytes) {
  return {
    async getObject() {
      return {
        $metadata: {
          httpStatusCode: 200,
          requestId: "post-probe-readback-request",
        },
        ContentLength: object.bytes,
        ETag: object.etag,
        ContentType: object.contentType,
        Metadata: {
          contract: object.customMetadata.contract,
          repositorycommit: object.customMetadata.repositoryCommit,
          sha256: object.sha256,
        },
        Body: Readable.from([bytes]),
      };
    },
  };
}

function finalLockAdapter(target) {
  return {
    async verifySelf() {
      return {
        httpStatus: 200,
        providerRequestId: "final-lock-verifier-preflight",
        responseBodySha256: sha256("final-lock-verifier-preflight-body"),
        credentialId: IDS.lockVerifier,
        status: "active",
        expiresAt: EXPIRY,
        notBefore: "2026-07-28T01:00:00.000Z",
      };
    },
    async readLock() {
      return {
        httpStatus: 200,
        providerRequestId: "final-lock-readback-request",
        responseBodySha256: sha256("final-lock-readback-body"),
        rules: structuredClone(target.lockRules),
      };
    },
  };
}

function trustPolicyFixture(protocol, target) {
  const keyPairs = new Map();
  const keys = REQUIRED_APPROVAL_ROLES.map((role) => {
    const pair = generateKeyPairSync("ed25519");
    const keyId = `${role}-bundle-v1`;
    keyPairs.set(keyId, pair);
    return {
      keyId,
      role,
      algorithm: "ed25519",
      publicKeySpkiBase64: pair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      notBefore: "2026-07-28T00:00:00.000Z",
      notAfter: "2027-07-28T00:00:00.000Z",
    };
  });
  const protocolPolicySha256 = sha256(
    Buffer.from(canonicalJson(protocol), "utf8"),
  );
  return {
    keyPairs,
    keys,
    trustPolicy: {
      schemaVersion: 2,
      contract: TRUST_POLICY_CONTRACT,
      policyId: "staging-r2-bundle-v1",
      protocolPolicySha256,
      repository: protocol.repository,
      environment: protocol.environment,
      provider: protocol.provider,
      target: {
        accountIdSha256: target.accountIdSha256,
        bucketName: target.bucketName,
        jurisdiction: target.jurisdiction,
        prefixRoot: protocol.prefixRoot,
      },
      minimumRetentionSeconds: protocol.minimumRetentionSeconds,
      maximumClockSkewSeconds: protocol.maximumClockSkewSeconds,
      maximumManifestLifetimeSeconds:
        protocol.maximumManifestLifetimeSeconds,
      maximumEvidenceAgeSeconds: protocol.maximumEvidenceAgeSeconds,
      requiredApprovalRoles: [...REQUIRED_APPROVAL_ROLES],
      keys,
    },
  };
}

function authorityReview(target) {
  const ids = new Map([
    ["publisher", sha256(IDS.publisher)],
    ["lock-operator", sha256(IDS.lockOperator)],
    ["object-verifier", sha256(IDS.objectVerifier)],
    ["lock-verifier", sha256(IDS.lockVerifier)],
    ["lifecycle-operator", sha256(IDS.lifecycleOperator)],
    ["lifecycle-verifier", sha256(IDS.lifecycleVerifier)],
  ]);
  return {
    schemaVersion: 1,
    contract: WORM_AUTHORITY_REVIEW_CONTRACT,
    ceremonyId: CEREMONY_ID,
    reviewedAt: "2026-07-28T01:41:00.000Z",
    target: {
      accountIdSha256: target.accountIdSha256,
      bucketName: target.bucketName,
      jurisdiction: target.jurisdiction,
      prefix: target.prefix,
    },
    secretMaterialCaptured: false,
    permissionInventoriesReviewed: true,
    authorities: REQUIRED_AUTHORITY_PROFILES.map((profile) => {
      const r2Scoped = profile.scopeType === "r2-bucket-prefix";
      return {
        role: profile.role,
        credentialType: profile.credentialType,
        credentialIdSha256: ids.get(profile.role),
        scopeType: profile.scopeType,
        accountIdSha256: target.accountIdSha256,
        bucketName: r2Scoped ? target.bucketName : null,
        prefix: r2Scoped ? target.prefix : null,
        permissions: profile.permissions,
        capabilities: profile.capabilities,
        expiresAt: EXPIRY,
      };
    }),
  };
}

function lifecycleAuthority(
  role,
  credentialType,
  id,
  selfVerifiedAt,
  remainingLifetimeSeconds,
) {
  return {
    role,
    credentialType,
    credentialIdSha256: sha256(id),
    selfVerifiedAt,
    expiresAt: EXPIRY,
    remainingLifetimeSeconds,
  };
}

function stagingOperation(operation, providerRequestId) {
  return {
    method: "GET",
    operation,
    httpStatus: 200,
    providerRequestId,
  };
}

function lifecycleOperation(
  method,
  operation,
  httpStatus,
  providerRequestId,
  responseBodySha256 = sha256(`${providerRequestId}-body`),
) {
  return {
    method,
    operation,
    httpStatus,
    providerRequestId,
    responseBodySha256,
  };
}

function stagingLimits() {
  return {
    requestTimeoutMs: 30_000,
    responseBytes: 1024 * 1024,
    mutableCredentialRemainingSeconds: 3_600,
    listPages: 1_000,
    listItems: 10_000,
    lockRules: 1_000,
  };
}

function lifecycleLimits() {
  return {
    requestTimeoutMs: 30_000,
    responseBytes: 1024 * 1024,
    predecessorReceiptBytes: 1024 * 1024,
    mutableCredentialRemainingSeconds: 3_600,
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

function canonicalText(value) {
  return `${canonicalJson(value)}\n`;
}

function sequenceNow(values) {
  let index = 0;
  return () => new Date(values[index++]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function minimalZip(name) {
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

async function readdirNames(directory) {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory);
}
