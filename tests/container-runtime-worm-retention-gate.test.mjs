import { describe, expect, test } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANCHOR_DOMAIN,
  EVIDENCE_CONTRACT,
  MANIFEST_CONTRACT,
  PROTOCOL_POLICY_CONTRACT,
  REQUIRED_APPROVAL_ROLES,
  REQUIRED_AUTHORITY_ROLES,
  REQUIRED_EVIDENCE_KINDS,
  REQUIRED_OBJECT_KINDS,
  REQUIRED_REVOCATION_TARGET_ROLES,
  TRUST_POLICY_CONTRACT,
  auditRepositoryContract,
  parseArgs,
  validateProtocolPolicy,
  verifyWormRetentionBundle,
} from "../tools/verify_container_runtime_worm_retention.mjs";
import {
  DSSE_PAYLOAD_TYPE,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
  canonicalJson,
} from "../tools/verify_container_runtime_provenance.mjs";

const NOW = new Date("2026-07-27T05:00:00Z");
const COMMIT = "1".repeat(40);
const ACCOUNT_ID_SHA256 = "a".repeat(64);
const BUCKET_NAME = "cinatoken-release-evidence-staging";
const SOURCE_RUN_ID = 30236225467;
const SIGNER_RUN_ID = 30236329194;
const LOCK_SECONDS = 400 * 24 * 60 * 60;
const OBJECT_CONTENT_TYPES = Object.freeze({
  "source-evidence-packet": "application/zip",
  "provenance-evidence-packet": "application/zip",
  "provenance-statement": "application/json",
  "sigstore-bundle": "application/json",
  "provenance-report": "application/json",
  "cosign-verification-log": "text/plain; charset=utf-8",
});
const SUBJECT_DIGESTS = Object.freeze({
  archiveSha256: "a".repeat(64),
  ociIndexSha256: "b".repeat(64),
  ociManifestSha256: "c".repeat(64),
  ociConfigSha256: "d".repeat(64),
  runtimeBinarySha256: "e".repeat(64),
  sbomSha256: "f".repeat(64),
  vulnerabilityScanSha256: "0".repeat(64),
});

describe("container runtime WORM retention gate", () => {
  test("keeps the offline audit and evidence modes exclusive", () => {
    expect(parseArgs(["--self-test", "--json"])).toEqual({
      selfTest: true,
      manifestPath: null,
      trustPolicyPath: null,
      now: null,
      json: true,
    });
    expect(
      parseArgs([
        "--manifest",
        "bundle/manifest.json",
        "--trust-policy",
        "trust.json",
        "--now",
        NOW.toISOString(),
        "--json",
      ]),
    ).toMatchObject({
      selfTest: false,
      manifestPath: "bundle/manifest.json",
      trustPolicyPath: "trust.json",
      now: NOW.toISOString(),
    });
    expect(() =>
      parseArgs(["--self-test", "--manifest", "manifest.json"]),
    ).toThrow(/cannot be combined/i);
    expect(() => parseArgs(["--manifest", "manifest.json"])).toThrow(
      /trust-policy/i,
    );
    expect(() =>
      parseArgs([
        "--manifest",
        "a",
        "--manifest",
        "b",
        "--trust-policy",
        "c",
      ]),
    ).toThrow(/duplicate/i);
  });

  test("pins the credential-free repository contract", async () => {
    const report = await auditRepositoryContract();
    expect(report).toMatchObject({
      status: "passed",
      credentialFree: true,
      remoteEvidenceVerified: false,
      evidenceStorageMutationPerformed: false,
      wormRetentionVerified: false,
      s3Complete: false,
      registryDigestAuthorized: false,
      productionCutoverAuthorized: false,
    });
    const policy = await loadProtocolPolicy();
    expect(validateProtocolPolicy(policy)).toEqual(policy);
    expect(policy.minimumRetentionSeconds).toBe(365 * 24 * 60 * 60);
    expect(policy.maximumCredentialRemainingSeconds).toBe(3_600);
    expect(policy.requiredAuthorityRoles).toEqual(
      REQUIRED_AUTHORITY_ROLES,
    );
    expect(policy.requiredRevocationTargetRoles).toEqual(
      REQUIRED_REVOCATION_TARGET_ROLES,
    );
  });

  test("rejects unknown retention bundle members", async () => {
    for (const relativePath of [
      "unexpected.json",
      "objects/unexpected.bin",
    ]) {
      const fixture = await createFixture();
      try {
        await writeFile(
          join(fixture.bundleRoot, relativePath),
          "unexpected\n",
        );
        await expect(fixture.verify()).rejects.toThrow(/layout/i);
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("accepts exact lock, readback, probes and independent anchors", async () => {
    const fixture = await createFixture();
    try {
      const report = await fixture.verify();
      expect(report).toMatchObject({
        status: "passed",
        decision: {
          s3CryptographicEvidence: true,
          immutableRetentionEvidence: true,
          s3Decision: "complete",
          registryDecision: "not-authorized",
          productionDecision: "not-authorized",
        },
        target: {
          accountIdSha256: ACCOUNT_ID_SHA256,
          bucketName: BUCKET_NAME,
          jurisdiction: "default",
        },
        retention: {
          mechanism: "cloudflare-r2-bucket-lock-api",
          objectCount: REQUIRED_OBJECT_KINDS.length,
          objectReadbackVerified: true,
          overwriteRejectedByProvider: true,
          deleteRejectedByProvider: true,
          postProbeObjectUnchanged: true,
        },
        authority: {
          separated: true,
          permissionInventoriesReviewed: true,
          lifecycleAuthoritySeparatedFromR2: true,
          lockOperatorRevocationVerified: true,
          publisherRevocationVerified: true,
          writeCredentialsRevokedBeforeDecision: true,
          approvalRoles: REQUIRED_APPROVAL_ROLES,
        },
        wormRetentionVerified: true,
        s3Complete: true,
        registryDigestAuthorized: false,
        cloudflareDeploymentDigestVerified: false,
        p5Eligible: false,
        customerTrafficAuthorized: false,
        productionCutoverAuthorized: false,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects authority overlap and capability escalation", async () => {
    for (const mutate of [
      (facts) => {
        facts.authorities[1].credentialIdSha256 =
          facts.authorities[0].credentialIdSha256;
      },
      (facts) => {
        facts.authorities[0].capabilities.r2LockWrite = true;
      },
      (facts) => {
        facts.authorities[4].permissions.push("r2-object-read");
      },
      (facts) => {
        facts.authorities[4].capabilities.r2ObjectRead = true;
      },
      (facts) => {
        facts.authorities[4].bucketName = BUCKET_NAME;
      },
      (facts) => {
        facts.authorities[0].expiresAt =
          "2026-07-27T07:00:00Z";
      },
      (facts) => {
        facts.permissionInventoriesReviewed = false;
      },
      (facts) => {
        facts.secretMaterialCaptured = true;
      },
      (facts) => {
        facts.apiToken = "not-a-real-secret";
      },
    ]) {
      const fixture = await createFixture();
      try {
        await fixture.updateEvidence("authority-boundary", (evidence) => {
          mutate(evidence.facts);
        });
        await expect(fixture.verify()).rejects.toThrow(
          /authority|least privilege|distinct|capability|credential|revocation|revoked|order/i,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("rejects incomplete or ambiguous lifecycle revocation evidence", async () => {
    const cases = [
      [
        "lock-operator-revocation",
        (facts) => {
          facts.deletion.at = facts.operatorSelfVerifiedAt;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.operatorReadback.at = facts.deletion.at;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.independentReadback.at =
            facts.verifierSelfVerifiedAt;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.deletion.httpStatus = 204;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.operatorReadback.httpStatus = 200;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.independentReadback.errorCodes = [1001];
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.lifecycleVerifierCredentialIdSha256 =
            facts.lifecycleOperatorCredentialIdSha256;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.targetBindingSha256 = "9".repeat(64);
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.verifyReceiptFileSha256 =
            facts.revokeReceiptFileSha256;
        },
      ],
      [
        "lock-operator-revocation",
        (facts) => {
          facts.verifierSelfVerifiedAt =
            "2026-07-27T04:56:20Z";
        },
      ],
      [
        "publisher-revocation",
        (facts) => {
          facts.deletion.resultIdSha256 =
            "9".repeat(64);
        },
      ],
      [
        "publisher-revocation",
        (facts) => {
          facts.operatorSelfVerifiedAt =
            "2026-07-27T04:57:59Z";
        },
      ],
      [
        "publisher-revocation",
        (facts) => {
          facts.independentReadback.at =
            "2026-07-27T04:58:21Z";
        },
      ],
    ];
    for (const [kind, mutate] of cases) {
      const fixture = await createFixture();
      try {
        await fixture.updateEvidence(kind, (evidence) => {
          mutate(evidence.facts);
          if (
            kind.endsWith("-revocation") &&
            evidence.facts.independentReadback?.at
          ) {
            evidence.capturedAt =
              evidence.facts.independentReadback.at;
          }
        });
        await expect(fixture.verify()).rejects.toThrow(
          /lifecycle|revocation|authority|receipt|provider|chronology|order|binding/i,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("rejects weak or mismatched lock evidence", async () => {
    for (const mutate of [
      (facts) => {
        facts.rules[0].enabled = false;
      },
      (facts) => {
        facts.rules[0].prefix = "container-runtime/s3/v1/attacker/";
      },
      (facts) => {
        facts.rules[0].condition.maxAgeSeconds = 30 * 24 * 60 * 60;
      },
      (facts) => {
        facts.awsS3ObjectLockHeadersUsed = true;
      },
      (facts) => {
        facts.configuredAt = "2026-07-27T04:59:30Z";
      },
      (facts) => {
        facts.observedAt = "2026-07-27T04:57:00Z";
      },
      (facts) => {
        facts.rules[0].condition = {
          type: "Date",
          date: "2027-02-30T00:00:00Z",
        };
      },
    ]) {
      const fixture = await createFixture();
      try {
        await fixture.updateEvidence("lock-readback", (evidence) => {
          mutate(evidence.facts);
          evidence.capturedAt = evidence.facts.observedAt;
        });
        await expect(fixture.verify()).rejects.toThrow(
          /lock|retention|configured|readback|ordering|timestamp/i,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("rejects object drift and retained provenance overclaim", async () => {
    const driftedObject = await createFixture();
    try {
      await driftedObject.replaceObject(
        "source-evidence-packet",
        Buffer.from("tampered source evidence", "utf8"),
        false,
      );
      await expect(driftedObject.verify()).rejects.toThrow(
        /digest or size mismatch/i,
      );
    } finally {
      await driftedObject.cleanup();
    }

    const driftedMetadata = await createFixture();
    try {
      await driftedMetadata.updateEvidence(
        "object-readback",
        (evidence) => {
          evidence.facts.objects[0].contentType =
            "application/octet-stream";
        },
      );
      await expect(driftedMetadata.verify()).rejects.toThrow(
        /object identity|readback/i,
      );
    } finally {
      await driftedMetadata.cleanup();
    }

    const overclaim = await createFixture();
    try {
      const reportRecord =
        overclaim.objects.get("provenance-report");
      const report = JSON.parse(
        (await readFile(reportRecord.filePath)).toString("utf8"),
      );
      report.productionCutoverAuthorized = true;
      await overclaim.replaceObject(
        "provenance-report",
        Buffer.from(canonicalJson(report), "utf8"),
        true,
      );
      await expect(overclaim.verify()).rejects.toThrow(
        /overclaims downstream authority/i,
      );
    } finally {
      await overclaim.cleanup();
    }
  });

  test("rejects ambiguous enforcement probes", async () => {
    for (const mutate of [
      (facts) => {
        facts.overwrite.httpStatus = 429;
      },
      (facts) => {
        facts.overwrite.providerRejected = false;
      },
      (facts) => {
        facts.delete.timedOut = true;
      },
      (facts) => {
        facts.delete.clientSideOnly = true;
      },
      (facts) => {
        facts.finalReadback.sha256 = "9".repeat(64);
      },
      (facts) => {
        facts.finalReadback.readBackAt = "2026-07-27T04:57:30Z";
      },
    ]) {
      const fixture = await createFixture();
      try {
        await fixture.updateEvidence("enforcement-probes", (evidence) => {
          mutate(evidence.facts);
        });
        await expect(fixture.verify()).rejects.toThrow(
          /provider rejection|post-probe|readback/i,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  test("rejects stale evidence and forged approvals", async () => {
    const stale = await createFixture();
    try {
      await stale.updateManifest((manifest) => {
        manifest.subject.generatedAt = "2026-07-27T03:00:00Z";
        manifest.subject.expiresAt = "2026-07-27T03:30:00Z";
      });
      await expect(stale.verify()).rejects.toThrow(/validity window/i);
    } finally {
      await stale.cleanup();
    }

    const forged = await createFixture();
    try {
      forged.manifest.approvals[0].signatureBase64Url =
        Buffer.alloc(64, 7).toString("base64url");
      await forged.writeManifest(false);
      await expect(forged.verify()).rejects.toThrow(/signature/i);
    } finally {
      await forged.cleanup();
    }

    const embeddedPolicy = await createFixture();
    try {
      const embeddedPath = join(
        embeddedPolicy.bundleRoot,
        "trust-policy.json",
      );
      await writeFile(
        embeddedPath,
        `${canonicalJson(embeddedPolicy.trustPolicy)}\n`,
      );
      await expect(
        verifyWormRetentionBundle({
          manifestPath: embeddedPolicy.manifestPath,
          trustPolicyPath: embeddedPath,
          now: NOW,
        }),
      ).rejects.toThrow(/outside the evidence bundle/i);
    } finally {
      await embeddedPolicy.cleanup();
    }
  });

  test("rejects protocol and trust-policy weakening", async () => {
    const policy = await loadProtocolPolicy();
    for (const mutate of [
      (value) => {
        value.schemaVersion = 1;
        value.contract =
          "cinatoken-container-runtime-worm-retention-protocol-policy-v1";
      },
      (value) => {
        value.minimumRetentionSeconds -= 1;
      },
      (value) => {
        value.maximumCredentialRemainingSeconds += 1;
      },
      (value) => {
        value.requiredApprovalRoles.pop();
      },
      (value) => {
        value.requiredAuthorityRoles.pop();
      },
      (value) => {
        value.requiredRevocationTargetRoles.pop();
      },
      (value) => {
        value.supportedJurisdictions.push("attacker");
      },
      (value) => {
        value.unreviewed = true;
      },
    ]) {
      const changed = structuredClone(policy);
      mutate(changed);
      expect(() => validateProtocolPolicy(changed)).toThrow(/policy/i);
    }

    const fixture = await createFixture();
    try {
      fixture.trustPolicy.minimumRetentionSeconds =
        30 * 24 * 60 * 60;
      await fixture.writeTrustPolicy();
      await expect(fixture.verify()).rejects.toThrow(
        /trust policy boundary/i,
      );
    } finally {
      await fixture.cleanup();
    }

    const oldTrust = await createFixture();
    try {
      oldTrust.trustPolicy.schemaVersion = 1;
      oldTrust.trustPolicy.contract =
        "cinatoken-container-runtime-worm-retention-trust-policy-v1";
      await oldTrust.writeTrustPolicy();
      await expect(oldTrust.verify()).rejects.toThrow(
        /trust policy (?:identity|boundary)/i,
      );
    } finally {
      await oldTrust.cleanup();
    }

    const oldManifest = await createFixture();
    try {
      await oldManifest.updateManifest((manifest) => {
        manifest.schemaVersion = 1;
        manifest.contract =
          "cinatoken-container-runtime-worm-retention-manifest-v1";
      });
      await expect(oldManifest.verify()).rejects.toThrow(
        /manifest identity/i,
      );
    } finally {
      await oldManifest.cleanup();
    }

    const oldEvidence = await createFixture();
    try {
      await oldEvidence.updateEvidence(
        "authority-boundary",
        (evidence) => {
          evidence.schemaVersion = 1;
          evidence.contract =
            "cinatoken-container-runtime-worm-retention-evidence-v1";
        },
      );
      await expect(oldEvidence.verify()).rejects.toThrow(
        /evidence identity/i,
      );
    } finally {
      await oldEvidence.cleanup();
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "cinatoken-worm-retention-"));
  const bundleRoot = join(root, "bundle");
  const evidenceRoot = join(bundleRoot, "evidence");
  const objectsRoot = join(bundleRoot, "objects");
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(objectsRoot, { recursive: true });

  const protocol = await loadProtocolPolicy();
  const protocolPolicySha256 = sha256(
    Buffer.from(canonicalJson(protocol), "utf8"),
  );
  const keyPairs = new Map();
  const keys = REQUIRED_APPROVAL_ROLES.map((role) => {
    const pair = generateKeyPairSync("ed25519");
    const keyId = `${role}-retention-v2`;
    keyPairs.set(keyId, pair);
    return {
      keyId,
      role,
      algorithm: "ed25519",
      publicKeySpkiBase64: pair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
      notBefore: "2026-07-27T00:00:00Z",
      notAfter: "2027-07-27T00:00:00Z",
    };
  });
  const trustPolicy = {
    schemaVersion: 2,
    contract: TRUST_POLICY_CONTRACT,
    policyId: "staging-r2-retention-v2",
    protocolPolicySha256,
    repository: protocol.repository,
    environment: protocol.environment,
    provider: protocol.provider,
    target: {
      accountIdSha256: ACCOUNT_ID_SHA256,
      bucketName: BUCKET_NAME,
      jurisdiction: "default",
      prefixRoot: protocol.prefixRoot,
    },
    minimumRetentionSeconds: protocol.minimumRetentionSeconds,
    maximumClockSkewSeconds: protocol.maximumClockSkewSeconds,
    maximumManifestLifetimeSeconds:
      protocol.maximumManifestLifetimeSeconds,
    maximumEvidenceAgeSeconds: protocol.maximumEvidenceAgeSeconds,
    requiredApprovalRoles: [...REQUIRED_APPROVAL_ROLES],
    keys,
  };
  const trustPolicyPath = join(root, "trust-policy.json");
  await writeFile(
    trustPolicyPath,
    `${canonicalJson(trustPolicy)}\n`,
  );

  const statement = statementFixture(protocol);
  const statementBytes = Buffer.from(canonicalJson(statement), "utf8");
  const statementSha256 = sha256(statementBytes);
  const bundle = bundleFixture(statementBytes);
  const bundleBytes = Buffer.from(canonicalJson(bundle), "utf8");
  const bundleSha256 = sha256(bundleBytes);
  const cosignLogBytes = Buffer.from("Verified OK\n", "utf8");
  const sourcePacketBytes = Buffer.from(
    "source evidence packet fixture\n",
    "utf8",
  );
  const provenancePacketBytes = Buffer.from(
    "provenance evidence packet fixture\n",
    "utf8",
  );
  const report = provenanceReportFixture({
    protocol,
    statementBytes,
    statementSha256,
    bundleBytes,
    bundleSha256,
    cosignLogBytes,
  });
  const reportBytes = Buffer.from(canonicalJson(report), "utf8");

  const objectInputs = new Map([
    ["source-evidence-packet", sourcePacketBytes],
    ["provenance-evidence-packet", provenancePacketBytes],
    ["provenance-statement", statementBytes],
    ["sigstore-bundle", bundleBytes],
    ["provenance-report", reportBytes],
    ["cosign-verification-log", cosignLogBytes],
  ]);
  const objectFileNames = {
    "source-evidence-packet": "container-runtime-source-evidence.zip",
    "provenance-evidence-packet":
      "container-runtime-provenance-evidence.zip",
    "provenance-statement": "container-runtime.provenance.slsa.json",
    "sigstore-bundle": "container-runtime.provenance.sigstore.json",
    "provenance-report":
      "container-runtime-provenance-verification.json",
    "cosign-verification-log": "cosign-verification.log",
  };
  const prefix = `${protocol.prefixRoot}${statementSha256}/`;
  const objects = new Map();
  for (let index = 0; index < REQUIRED_OBJECT_KINDS.length; index += 1) {
    const kind = REQUIRED_OBJECT_KINDS[index];
    const bytes = objectInputs.get(kind);
    const fileName = objectFileNames[kind];
    const filePath = join(objectsRoot, fileName);
    await writeFile(filePath, bytes);
    const digest = sha256(bytes);
    objects.set(kind, {
      kind,
      fileName,
      filePath,
      path: `objects/${fileName}`,
      key: `${prefix}${fileName}`,
      bytes: bytes.length,
      sha256: digest,
      etag: `"fixture-etag-${index}"`,
      contentType: OBJECT_CONTENT_TYPES[kind],
      uploadedAt: `2026-07-27T04:56:${String(30 + index).padStart(2, "0")}Z`,
      uploadHttpStatus: 200,
      uploadRequestId: `upload-request-${index}`,
      readBackAt: `2026-07-27T04:57:${String(index).padStart(2, "0")}Z`,
      httpStatus: 200,
      providerRequestId: `readback-request-${index}`,
      customMetadata: {
        contract: MANIFEST_CONTRACT,
        repositoryCommit: COMMIT,
        sha256: digest,
      },
    });
  }

  const ceremonyId = "123e4567-e89b-42d3-a456-426614174000";
  const evidenceValues = new Map();
  evidenceValues.set(
    "authority-boundary",
    evidenceEnvelope(
      "authority-boundary",
      ceremonyId,
      "2026-07-27T04:59:10Z",
      {
        accountIdSha256: ACCOUNT_ID_SHA256,
        bucketName: BUCKET_NAME,
        prefix,
        secretMaterialCaptured: false,
        allCredentialIdsDistinct: true,
        permissionInventoriesReviewed: true,
        authorities: [
          authorityFixture(
            "publisher",
            "r2-object-read-write-api-token",
            "2".repeat(64),
            prefix,
            "r2-bucket-prefix",
            ["r2-object-read", "r2-object-write"],
            {
              r2ObjectRead: true,
              r2ObjectWrite: true,
              r2LockRead: false,
              r2LockWrite: false,
              accountTokenRead: false,
              accountTokenEdit: false,
            },
          ),
          authorityFixture(
            "lock-operator",
            "cloudflare-r2-admin-read-write-api-token",
            "3".repeat(64),
            prefix,
            "r2-bucket-prefix",
            ["r2-admin-read-write"],
            {
              r2ObjectRead: true,
              r2ObjectWrite: true,
              r2LockRead: true,
              r2LockWrite: true,
              accountTokenRead: false,
              accountTokenEdit: false,
            },
          ),
          authorityFixture(
            "object-verifier",
            "r2-object-read-api-token",
            "4".repeat(64),
            prefix,
            "r2-bucket-prefix",
            ["r2-object-read"],
            {
              r2ObjectRead: true,
              r2ObjectWrite: false,
              r2LockRead: false,
              r2LockWrite: false,
              accountTokenRead: false,
              accountTokenEdit: false,
            },
          ),
          authorityFixture(
            "lock-verifier",
            "cloudflare-r2-admin-read-api-token",
            "5".repeat(64),
            prefix,
            "r2-bucket-prefix",
            ["r2-admin-read"],
            {
              r2ObjectRead: true,
              r2ObjectWrite: false,
              r2LockRead: true,
              r2LockWrite: false,
              accountTokenRead: false,
              accountTokenEdit: false,
            },
          ),
          authorityFixture(
            "lifecycle-operator",
            "cloudflare-account-api-token-read-edit",
            "6".repeat(64),
            prefix,
            "cloudflare-account",
            ["account-api-token-read", "account-api-token-edit"],
            {
              r2ObjectRead: false,
              r2ObjectWrite: false,
              r2LockRead: false,
              r2LockWrite: false,
              accountTokenRead: true,
              accountTokenEdit: true,
            },
          ),
          authorityFixture(
            "lifecycle-verifier",
            "cloudflare-account-api-token-read",
            "7".repeat(64),
            prefix,
            "cloudflare-account",
            ["account-api-token-read"],
            {
              r2ObjectRead: false,
              r2ObjectWrite: false,
              r2LockRead: false,
              r2LockWrite: false,
              accountTokenRead: true,
              accountTokenEdit: false,
            },
          ),
        ],
      },
    ),
  );
  evidenceValues.set(
    "lock-operator-revocation",
    evidenceEnvelope(
      "lock-operator-revocation",
      ceremonyId,
      "2026-07-27T04:56:23Z",
      lifecycleRevocationFixture({
        targetRole: "lock-operator",
        targetCredentialIdSha256: "3".repeat(64),
        prefix,
        operatorSelfVerifiedAt: "2026-07-27T04:56:10Z",
        deletedAt: "2026-07-27T04:56:20Z",
        operatorReadbackAt: "2026-07-27T04:56:21Z",
        verifierSelfVerifiedAt: "2026-07-27T04:56:22Z",
        independentReadbackAt: "2026-07-27T04:56:23Z",
        digestFills: ["8", "9", "a"],
      }),
    ),
  );
  evidenceValues.set(
    "object-readback",
    evidenceEnvelope(
      "object-readback",
      ceremonyId,
      "2026-07-27T04:57:30Z",
      {
        accountIdSha256: ACCOUNT_ID_SHA256,
        bucketName: BUCKET_NAME,
        jurisdiction: "default",
        prefix,
        baselineObservedAt: "2026-07-27T04:55:30Z",
        baselinePaginationComplete: true,
        preexistingObjectCount: 0,
        multipartUploadCount: 0,
        unknownObjectCount: 0,
        finalPaginationComplete: true,
        createOnlyWritesVerified: true,
        awsS3ObjectLockHeadersUsed: false,
        objects: [...objects.values()].map(objectRecord),
      },
    ),
  );
  const probeTarget = objects.get("provenance-evidence-packet");
  evidenceValues.set(
    "enforcement-probes",
    evidenceEnvelope(
      "enforcement-probes",
      ceremonyId,
      "2026-07-27T04:58:30Z",
      {
        accountIdSha256: ACCOUNT_ID_SHA256,
        bucketName: BUCKET_NAME,
        jurisdiction: "default",
        prefix,
        targetObjectKind: probeTarget.kind,
        targetKey: probeTarget.key,
        originalSha256: probeTarget.sha256,
        originalBytes: probeTarget.bytes,
        overwrite: {
          operation: "put-object",
          attemptedAt: "2026-07-27T04:58:00Z",
          attemptedBytes: probeTarget.bytes + 1,
          attemptedSha256: "5".repeat(64),
          transportCompleted: true,
          timedOut: false,
          clientSideOnly: false,
          providerRejected: true,
          httpStatus: 403,
          errorCode: "AccessDenied",
          providerRequestId: "overwrite-request-1",
          responseBodySha256: "6".repeat(64),
        },
        delete: {
          operation: "delete-object",
          attemptedAt: "2026-07-27T04:58:05Z",
          attemptedBytes: 0,
          attemptedSha256: probeTarget.sha256,
          transportCompleted: true,
          timedOut: false,
          clientSideOnly: false,
          providerRejected: true,
          httpStatus: 403,
          errorCode: "AccessDenied",
          providerRequestId: "delete-request-1",
          responseBodySha256: "7".repeat(64),
        },
        finalReadback: {
          readBackAt: "2026-07-27T04:58:20Z",
          httpStatus: 200,
          providerRequestId: "post-probe-readback-1",
          bytes: probeTarget.bytes,
          sha256: probeTarget.sha256,
          etag: probeTarget.etag,
        },
      },
    ),
  );
  evidenceValues.set(
    "publisher-revocation",
    evidenceEnvelope(
      "publisher-revocation",
      ceremonyId,
      "2026-07-27T04:58:13Z",
      lifecycleRevocationFixture({
        targetRole: "publisher",
        targetCredentialIdSha256: "2".repeat(64),
        prefix,
        operatorSelfVerifiedAt: "2026-07-27T04:58:06Z",
        deletedAt: "2026-07-27T04:58:10Z",
        operatorReadbackAt: "2026-07-27T04:58:11Z",
        verifierSelfVerifiedAt: "2026-07-27T04:58:12Z",
        independentReadbackAt: "2026-07-27T04:58:13Z",
        digestFills: ["b", "c", "d"],
      }),
    ),
  );
  evidenceValues.set(
    "lock-readback",
    evidenceEnvelope(
      "lock-readback",
      ceremonyId,
      "2026-07-27T04:59:00Z",
      {
        mechanism: "cloudflare-r2-bucket-lock-api",
        awsS3ObjectLockHeadersUsed: false,
        accountIdSha256: ACCOUNT_ID_SHA256,
        bucketName: BUCKET_NAME,
        jurisdiction: "default",
        prefix,
        configuredAt: "2026-07-27T04:56:00Z",
        configurationRequestId: "lock-configuration-request-1",
        observedAt: "2026-07-27T04:59:00Z",
        readbackRequestId: "lock-readback-request-1",
        httpStatus: 200,
        selectedRuleId: "cinatoken-release-evidence-v1",
        rules: [
          {
            id: "cinatoken-release-evidence-v1",
            condition: {
              type: "Age",
              maxAgeSeconds: LOCK_SECONDS,
            },
            enabled: true,
            prefix,
          },
        ],
      },
    ),
  );

  const evidenceRecords = [];
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    const value = evidenceValues.get(kind);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    const path = join(evidenceRoot, `${kind}.json`);
    await writeFile(path, bytes);
    evidenceRecords.push({
      kind,
      path: `evidence/${kind}.json`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      capturedAt: value.capturedAt,
      expiresAt: value.expiresAt,
    });
  }

  const manifest = {
    schemaVersion: 2,
    contract: MANIFEST_CONTRACT,
    subject: {
      environment: protocol.environment,
      repository: protocol.repository,
      commitSha: COMMIT,
      ceremonyId,
      generatedAt: NOW.toISOString(),
      expiresAt: "2026-07-27T05:30:00Z",
      provider: protocol.provider,
      accountIdSha256: ACCOUNT_ID_SHA256,
      bucketName: BUCKET_NAME,
      jurisdiction: "default",
      prefix,
      policyId: trustPolicy.policyId,
      provenance: {
        sourceRunId: SOURCE_RUN_ID,
        signerRunId: SIGNER_RUN_ID,
        sourceArtifactSha256: objects.get("source-evidence-packet").sha256,
        provenanceArtifactSha256:
          objects.get("provenance-evidence-packet").sha256,
        statementSha256,
        bundleSha256,
        subject: { ...SUBJECT_DIGESTS },
      },
      evidence: evidenceRecords,
    },
    subjectDigestSha256: "",
    approvals: [],
  };
  const manifestPath = join(bundleRoot, "manifest.json");

  const fixture = {
    root,
    bundleRoot,
    manifestPath,
    trustPolicyPath,
    trustPolicy,
    protocol,
    keyPairs,
    manifest,
    evidenceValues,
    objects,
    async verify() {
      return verifyWormRetentionBundle({
        manifestPath,
        trustPolicyPath,
        now: NOW,
      });
    },
    async writeTrustPolicy() {
      await writeFile(
        trustPolicyPath,
        `${canonicalJson(trustPolicy)}\n`,
      );
    },
    async writeManifest(resign = true) {
      if (resign) signManifest(manifest, trustPolicy, keyPairs);
      await writeFile(
        manifestPath,
        `${canonicalJson(manifest)}\n`,
      );
    },
    async updateManifest(mutator) {
      mutator(manifest);
      await this.writeManifest(true);
    },
    async updateEvidence(kind, mutator) {
      const value = evidenceValues.get(kind);
      mutator(value);
      const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
      await writeFile(join(evidenceRoot, `${kind}.json`), bytes);
      const record = manifest.subject.evidence.find(
        (entry) => entry.kind === kind,
      );
      record.bytes = bytes.length;
      record.sha256 = sha256(bytes);
      record.capturedAt = value.capturedAt;
      record.expiresAt = value.expiresAt;
      await this.writeManifest(true);
    },
    async replaceObject(kind, bytes, updateReadback) {
      const object = objects.get(kind);
      await writeFile(object.filePath, bytes);
      if (!updateReadback) return;
      object.bytes = bytes.length;
      object.sha256 = sha256(bytes);
      object.customMetadata.sha256 = object.sha256;
      const readback = evidenceValues.get("object-readback");
      const record = readback.facts.objects.find(
        (entry) => entry.kind === kind,
      );
      Object.assign(record, objectRecord(object));
      await this.updateEvidence("object-readback", () => {});
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  await fixture.writeManifest(true);
  return fixture;
}

function evidenceEnvelope(kind, ceremonyId, capturedAt, facts) {
  return {
    schemaVersion: 2,
    contract: EVIDENCE_CONTRACT,
    kind,
    ceremonyId,
    capturedAt,
    expiresAt: "2026-07-27T05:31:00Z",
    status: "pass",
    facts,
  };
}

function authorityFixture(
  role,
  credentialType,
  credentialIdSha256,
  prefix,
  scopeType,
  permissions,
  capabilities,
) {
  const r2Scoped = scopeType === "r2-bucket-prefix";
  return {
    role,
    credentialType,
    credentialIdSha256,
    scopeType,
    accountIdSha256: ACCOUNT_ID_SHA256,
    bucketName: r2Scoped ? BUCKET_NAME : null,
    prefix: r2Scoped ? prefix : null,
    permissions,
    capabilities,
    expiresAt: "2026-07-27T05:45:00Z",
  };
}

function lifecycleRevocationFixture({
  targetRole,
  targetCredentialIdSha256,
  prefix,
  operatorSelfVerifiedAt,
  deletedAt,
  operatorReadbackAt,
  verifierSelfVerifiedAt,
  independentReadbackAt,
  digestFills,
}) {
  const apiSurface = "cloudflare-account-token-api";
  return {
    accountIdSha256: ACCOUNT_ID_SHA256,
    bucketName: BUCKET_NAME,
    prefix,
    targetRole,
    targetCredentialIdSha256,
    lifecycleOperatorCredentialIdSha256: "6".repeat(64),
    lifecycleVerifierCredentialIdSha256: "7".repeat(64),
    apiSurface,
    targetBindingSha256: sha256(
      Buffer.from(
        canonicalJson({
          apiSurface,
          accountIdSha256: ACCOUNT_ID_SHA256,
          targetCredentialIdSha256,
        }),
        "utf8",
      ),
    ),
    predecessorReceiptFileSha256: digestFills[0].repeat(64),
    revokeReceiptFileSha256: digestFills[1].repeat(64),
    verifyReceiptFileSha256: digestFills[2].repeat(64),
    operatorSelfVerifiedAt,
    deletion: {
      at: deletedAt,
      httpStatus: 200,
      providerRequestId: `${targetRole}-delete-request`,
      responseBodySha256: sha256(
        Buffer.from(`${targetRole}-delete-response`, "utf8"),
      ),
      resultIdSha256: targetCredentialIdSha256,
    },
    operatorReadback: {
      at: operatorReadbackAt,
      httpStatus: 404,
      providerRequestId: `${targetRole}-operator-readback-request`,
      responseBodySha256: sha256(
        Buffer.from(`${targetRole}-operator-readback`, "utf8"),
      ),
      errorCodes: [1000],
    },
    verifierSelfVerifiedAt,
    independentReadback: {
      at: independentReadbackAt,
      httpStatus: 404,
      providerRequestId:
        `${targetRole}-independent-readback-request`,
      responseBodySha256: sha256(
        Buffer.from(`${targetRole}-independent-readback`, "utf8"),
      ),
      errorCodes: [1000],
    },
    targetAbsenceIndependentlyObserved: true,
  };
}

function objectRecord(value) {
  return {
    kind: value.kind,
    path: value.path,
    key: value.key,
    bytes: value.bytes,
    sha256: value.sha256,
    etag: value.etag,
    contentType: value.contentType,
    uploadedAt: value.uploadedAt,
    uploadHttpStatus: value.uploadHttpStatus,
    uploadRequestId: value.uploadRequestId,
    readBackAt: value.readBackAt,
    httpStatus: value.httpStatus,
    providerRequestId: value.providerRequestId,
    customMetadata: { ...value.customMetadata },
  };
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
        builder: {
          id: "https://github.com/actions/runner/github-hosted",
        },
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

function provenanceReportFixture({
  protocol,
  statementBytes,
  statementSha256,
  bundleBytes,
  bundleSha256,
  cosignLogBytes,
}) {
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
      cosignLinuxAmd64Sha256:
        "f7622ed3cf22e55e1ae6377c080979ff77a22da9981c11df222a2e444991e7cf",
      cosignVersion: "v3.1.2",
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

function bundleFixture(statementBytes) {
  const base64 = (length, fill) =>
    Buffer.alloc(length, fill).toString("base64");
  return {
    mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE,
    verificationMaterial: {
      certificate: {
        rawBytes: base64(512, 1),
      },
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
          {
            signedTimestamp: base64(256, 7),
          },
        ],
      },
    },
    dsseEnvelope: {
      payload: statementBytes.toString("base64"),
      payloadType: DSSE_PAYLOAD_TYPE,
      signatures: [
        {
          sig: base64(64, 8),
        },
      ],
    },
  };
}

function signManifest(manifest, trustPolicy, keyPairs) {
  manifest.subjectDigestSha256 = sha256(
    Buffer.from(canonicalJson(manifest.subject), "utf8"),
  );
  const message = Buffer.from(
    `${ANCHOR_DOMAIN}\n${trustPolicy.policyId}\n${manifest.subjectDigestSha256}\n`,
    "utf8",
  );
  manifest.approvals = REQUIRED_APPROVAL_ROLES.map((role) => {
    const key = trustPolicy.keys.find((entry) => entry.role === role);
    return {
      role,
      keyId: key.keyId,
      algorithm: "ed25519",
      signatureBase64Url: sign(
        null,
        message,
        keyPairs.get(key.keyId).privateKey,
      ).toString("base64url"),
    };
  });
}

async function loadProtocolPolicy() {
  const value = JSON.parse(
    await Bun.file(
      new URL(
        "../config/container-runtime-worm-retention-policy.json",
        import.meta.url,
      ),
    ).text(),
  );
  expect(value.contract).toBe(PROTOCOL_POLICY_CONTRACT);
  expect(value.requiredEvidenceKinds).toEqual(REQUIRED_EVIDENCE_KINDS);
  expect(value.requiredObjectKinds).toEqual(REQUIRED_OBJECT_KINDS);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
