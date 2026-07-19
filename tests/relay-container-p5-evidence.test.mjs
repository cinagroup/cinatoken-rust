import { afterAll, describe, expect, test } from "bun:test";
import {
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EVIDENCE_CONTRACT,
  FOUNDATION_CAPTURE_CONTRACT,
  FOUNDATION_COLLECTOR_VERSION,
  MANIFEST_CONTRACT,
  REQUIRED_APPROVAL_ROLES,
  REQUIRED_EVIDENCE_KINDS,
  REQUIRED_LIFECYCLE_SCENARIOS,
  REQUIRED_PROVENANCE_SEGMENTS,
  TRUST_POLICY_CONTRACT,
  approvalMessage,
  base64UrlEncode,
  canonicalJson,
  sha256Hex,
  verifyP5Bundle,
} from "../tools/relay_container_p5_evidence_contract.mjs";

const fixedNow = new Date("2026-07-19T10:07:00.000Z");
const capturedAt = "2026-07-19T10:00:00.000Z";
const generatedAt = "2026-07-19T10:05:00.000Z";
const signedAt = "2026-07-19T10:06:00.000Z";
const expiresAt = "2026-07-19T20:00:00.000Z";
const temporaryRoots = [];
const foundationCollectorSha256 = "e".repeat(64);
const foundationObservationStartedAt = "2026-07-19T09:50:00.000Z";
const foundationObservationEndedAt = "2026-07-19T09:58:00.000Z";

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Relay Container P5 evidence contract", () => {
  test("accepts one complete independently approved staging packet", async () => {
    const bundle = await createBundle();
    const result = await verify(bundle);
    expect(result.ok).toBe(true);
    expect(result.evidenceKinds).toEqual(REQUIRED_EVIDENCE_KINDS);
    expect(result.foundationCaptureSha256).toBe(
      bundle.foundationCaptureSha256,
    );
    expect(result.foundationArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.approvalRoles).toEqual(REQUIRED_APPROVAL_ROLES);
    expect(result.isolatedStagingSyntheticCanaryEligible).toBe(true);
    expect(result.customerTrafficEligible).toBe(false);
    expect(result.productionEligible).toBe(false);
    expect(result.safetyBoundary).toEqual({
      customerTraffic: false,
      productionCutover: false,
      remoteMutationPerformedByVerifier: false,
      credentialsReadByVerifier: false,
    });
  }, 15_000);

  test("rejects noncanonical manifest JSON", async () => {
    const bundle = await createBundle();
    const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
    await writeFile(bundle.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(verify(bundle)).rejects.toThrow(/canonical JSON/);
  });

  test("rejects the superseded manifest v1 contract", async () => {
    const bundle = await createBundle({
      mutateManifest: (manifest) => {
        manifest.schemaVersion = 1;
        manifest.contract =
          "cinatoken-relay-container-p5-promotion-manifest-v1";
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/schemaVersion/);
  });

  test("rejects duplicate JSON members", async () => {
    const bundle = await createBundle();
    const manifest = await readFile(bundle.manifestPath, "utf8");
    await writeFile(
      bundle.manifestPath,
      manifest.replace("{", `{"contract":"${MANIFEST_CONTRACT}",`),
    );
    await expect(verify(bundle)).rejects.toThrow(/canonical JSON/);
  });

  test("rejects negative zero and unsafe JSON integers", async () => {
    const negativeZero = await createBundle();
    await writeFile(
      negativeZero.manifestPath,
      (await readFile(negativeZero.manifestPath, "utf8")).replace(
        '"schemaVersion":2',
        '"schemaVersion":-0',
      ),
    );
    await expect(verify(negativeZero)).rejects.toThrow(/canonical JSON/);

    const unsafeInteger = await createBundle();
    await writeFile(
      unsafeInteger.manifestPath,
      (await readFile(unsafeInteger.manifestPath, "utf8")).replace(
        '"schemaVersion":2',
        '"schemaVersion":9007199254740992',
      ),
    );
    await expect(verify(unsafeInteger)).rejects.toThrow(/safe integers/);
  });

  test("rejects invalid UTF-8 and extra trailing newlines", async () => {
    const invalidUtf8 = await createBundle();
    await writeFile(invalidUtf8.manifestPath, Buffer.from([0xff, 0xfe]));
    await expect(verify(invalidUtf8)).rejects.toThrow(/valid UTF-8/);

    const extraNewline = await createBundle();
    await writeFile(
      extraNewline.manifestPath,
      `${await readFile(extraNewline.manifestPath, "utf8")}\n`,
    );
    await expect(verify(extraNewline)).rejects.toThrow(/canonical JSON/);
  });

  test("rejects a canonical __proto__ member as an unknown field", async () => {
    const bundle = await createBundle({
      mutateManifest: (manifest) => {
        Object.defineProperty(manifest, "__proto__", {
          value: { authorizesTraffic: true },
          enumerable: true,
        });
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/unknown or missing fields/);
  });

  test("rejects an evidence digest mismatch", async () => {
    const bundle = await createBundle({
      afterWrite: async ({ evidencePaths }) => {
        await writeFile(evidencePaths.get("remote-inventory"), "{}\n");
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/byte count mismatch|digest mismatch/);
  });

  test("rejects a foundation capture changed after manifest assembly", async () => {
    const bundle = await createBundle({
      afterWrite: async ({ foundationPath }) => {
        await writeFile(foundationPath, "{}\n");
      },
    });
    await expect(verify(bundle)).rejects.toThrow(
      /capture byte count mismatch|capture artifact digest mismatch/,
    );
  });

  test("rejects a foundation capture whose readiness claims are contradictory", async () => {
    const bundle = await createBundle({
      mutateFoundationCapture: (capture) => {
        capture.subject.readbackStable = false;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/readback stability/);
  });

  test("rejects failed or cross-campaign foundation evidence", async () => {
    const failed = await createBundle({
      mutateFoundationCapture: (capture) => {
        capture.subject.evidenceFacts.remoteInventory.shardActivationCampaign.state =
          "sealed_failed";
      },
    });
    await expect(verify(failed)).rejects.toThrow(/campaign state/);

    const crossCampaign = await createBundle({
      mutateFoundationCapture: (capture) => {
        capture.subject.evidenceFacts.remoteInventory.shardActivationCampaign.campaignId =
          "f".repeat(64);
      },
    });
    await expect(verify(crossCampaign)).rejects.toThrow(/same sealed activation campaign/);
  });

  test("rejects the pre-0055 schema totals", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "schema-readback") {
          evidence.facts.incrementalColumnCount = 770;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/incremental columns/);
  });

  test("rejects evidence facts that differ from the bound foundation artifact", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "candidate-freeze") {
          evidence.facts.artifactInventorySha256 = "f".repeat(64);
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(
      /candidate-freeze facts do not match the capture artifact/,
    );
  });

  test("rejects a symlinked evidence path whose target remains in the bundle", async () => {
    const bundle = await createBundle();
    const evidencePath = bundle.evidencePaths.get("candidate-freeze");
    if (process.platform === "win32") {
      const targetPath = path.join(path.dirname(evidencePath), "candidate-freeze-target");
      await mkdir(targetPath);
      await rm(evidencePath);
      await symlink(targetPath, evidencePath, "junction");
    } else {
      const targetPath = path.join(
        path.dirname(evidencePath),
        "candidate-freeze-target.json",
      );
      await rename(evidencePath, targetPath);
      await symlink(path.basename(targetPath), evidencePath, "file");
    }
    await expect(verify(bundle)).rejects.toThrow(/regular non-symlink file/);
  });

  test("rejects a candidate digest mismatch", async () => {
    const bundle = await createBundle({
      mutateSubject: (subject) => {
        subject.candidateDigestSha256 = "f".repeat(64);
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/candidate digest mismatch/);
  });

  test("rejects unknown manifest fields", async () => {
    const bundle = await createBundle({
      mutateManifest: (manifest) => {
        manifest.authorizesTraffic = true;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/unknown or missing fields/);
  });

  test("rejects customer traffic in the isolated staging cohort", async () => {
    const bundle = await createBundle({
      mutateCohort: (cohort) => {
        cohort.customerTraffic = true;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/customer traffic mismatch/);
  });

  test("rejects different foundation captures across freeze and inventory", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "remote-inventory") {
          evidence.facts.foundationCaptureSha256 = "f".repeat(64);
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/must bind the same capture/);
  });

  test("rejects incomplete foundation pagination", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "candidate-freeze") {
          evidence.facts.paginationComplete = false;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/pagination completeness/);
  });

  test("rejects a foundation window ending after evidence capture", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "remote-inventory") {
          evidence.facts.observationEndedAt = "2026-07-19T10:01:00.000Z";
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/ended after evidence capture/);
  });

  test("rejects a stale foundation window even when its duration is valid", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "candidate-freeze") {
          evidence.facts.observationStartedAt = "2026-07-19T09:00:00.000Z";
          evidence.facts.observationEndedAt = "2026-07-19T09:08:00.000Z";
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/stale for evidence capture/);
  });

  test("rejects stale evidence even when its hash and approvals match", async () => {
    const bundle = await createBundle({
      mutateEvidence: (_kind, evidence) => {
        evidence.capturedAt = "2026-07-01T10:00:00.000Z";
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/evidence is stale/);
  });

  test("rejects evidence captured after manifest generation", async () => {
    const bundle = await createBundle({
      mutateEvidence: (_kind, evidence) => {
        evidence.capturedAt = "2026-07-19T10:06:00.000Z";
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/captured after manifest generation/);
  });

  test("rejects a writer-before-reader packet", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "reader-first-rollout") {
          evidence.facts.readersDeployedBeforeWriters = false;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/readersDeployedBeforeWriters mismatch/);
  });

  test("rejects an elapsed synthetic canary window", async () => {
    const bundle = await createBundle();
    await expect(
      verify(bundle, new Date("2026-07-19T12:06:00.000Z")),
    ).rejects.toThrow(/canary window has elapsed/);
  });

  test("rejects an incomplete lifecycle fault inventory", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "lifecycle-fault-campaign") {
          delete evidence.facts.scenarioResults.container_oom;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/scenarios has unknown or missing fields/);
  });

  test("rejects duplicate provider calls", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "response-financial-fault-campaign") {
          evidence.facts.duplicateProviderCalls = 1;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/duplicateProviderCalls mismatch/);
  });

  test("rejects request accounting on a refund", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "response-financial-fault-campaign") {
          evidence.facts.requestAccountingOnRefund = 1;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/requestAccountingOnRefund mismatch/);
  });

  test("rejects financial terminal counts that do not conserve provider operations", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "response-financial-fault-campaign") {
          evidence.facts.refundedOperations = 11;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/financial terminal conservation mismatch/);
  });

  test("rejects response case counts that do not conserve provider operations", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "response-financial-fault-campaign") {
          evidence.facts.providerCalls = 4;
          evidence.facts.providerOperations = 4;
          evidence.facts.settledOperations = 1;
          evidence.facts.refundedOperations = 3;
          evidence.facts.recoveryOperations = 1;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/response case conservation mismatch/);
  });

  test("rejects incomplete cross-layer provenance", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "cross-layer-provenance") {
          evidence.facts.missingSegmentCount = 1;
        }
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/missing segments mismatch/);
  });

  test("rejects a load window below the production threshold", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "load-cost-slo") evidence.facts.durationSeconds = 3599;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/duration is out of range/);
  });

  test("rejects rollback that did not disable writers first", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "rollback-rehearsal") evidence.facts.disableFirst = false;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/disableFirst mismatch/);
  });

  test("rejects evidence paths outside the bundle", async () => {
    const bundle = await createBundle({
      mutateArtifactRecords: (records) => {
        records[0].path = "../candidate-freeze.json";
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/path is invalid/);
  });

  test("rejects a trust policy carried inside the evidence bundle", async () => {
    const bundle = await createBundle();
    const bundledPolicyPath = path.join(bundle.root, "bundled-trust-policy.json");
    await writeFile(bundledPolicyPath, await readFile(bundle.trustPolicyPath));
    await expect(
      verifyP5Bundle({
        manifestPath: bundle.manifestPath,
        trustPolicyPath: bundledPolicyPath,
        now: fixedNow,
      }),
    ).rejects.toThrow(/outside the evidence bundle/);
  });

  test("rejects a same-directory trust policy whose name begins with two dots", async () => {
    const bundle = await createBundle();
    const disguisedPolicyPath = path.join(bundle.root, "..policy.json");
    await writeFile(disguisedPolicyPath, await readFile(bundle.trustPolicyPath));
    await expect(
      verifyP5Bundle({
        manifestPath: bundle.manifestPath,
        trustPolicyPath: disguisedPolicyPath,
        now: fixedNow,
      }),
    ).rejects.toThrow(/outside the evidence bundle/);
  });

  test("rejects role keys that reuse the same Ed25519 public key", async () => {
    const bundle = await createBundle({ reuseApprovalKeyMaterial: true });
    await expect(verify(bundle)).rejects.toThrow(/cryptographically distinct/);
  });

  test("rejects missing approvals", async () => {
    const bundle = await createBundle({
      mutateApprovals: (approvals) => approvals.pop(),
    });
    await expect(verify(bundle)).rejects.toThrow(/exactly five approvals/);
  });

  test("rejects approval signed before the last evidence", async () => {
    const bundle = await createBundle({
      approvalSignedAt: "2026-07-19T09:59:00.000Z",
    });
    await expect(verify(bundle)).rejects.toThrow(/predates the complete evidence bundle/);
  });

  test("rejects an approval whose signature time is not before its expiry", async () => {
    const bundle = await createBundle({
      approvalSignedAt: "2026-07-19T20:01:00.000Z",
      mutateCohort: (cohort) => {
        cohort.windowStartsAt = "2026-07-19T19:58:00.000Z";
        cohort.windowEndsAt = "2026-07-19T19:59:00.000Z";
      },
    });
    await expect(
      verify(bundle, new Date("2026-07-19T20:02:00.000Z")),
    ).rejects.toThrow(/validity window is empty/);
  });

  test("rejects an approval signed after the decision window", async () => {
    const bundle = await createBundle({
      approvalSignedAt: "2026-07-19T20:01:00.000Z",
      approvalExpiresAt: "2026-07-19T20:30:00.000Z",
      mutateCohort: (cohort) => {
        cohort.windowStartsAt = "2026-07-19T19:58:00.000Z";
        cohort.windowEndsAt = "2026-07-19T19:59:00.000Z";
      },
    });
    await expect(
      verify(bundle, new Date("2026-07-19T19:59:00.000Z")),
    ).rejects.toThrow(/signed after the decision window/);
  });

  test("rejects a tampered approval signature", async () => {
    const bundle = await createBundle({
      mutateApprovals: (approvals) => {
        approvals[0].signatureBase64url = base64UrlEncode(Buffer.alloc(64, 7));
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/signature verification failed/);
  });

  test("rejects a role using another owner's key", async () => {
    const bundle = await createBundle({
      mutateApprovals: (approvals) => {
        approvals[0].keyId = approvals[1].keyId;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/untrusted role key/);
  });

  test("rejects a decision that outlives its evidence", async () => {
    const bundle = await createBundle({
      mutateEvidence: (_kind, evidence) => {
        evidence.expiresAt = "2026-07-19T19:00:00.000Z";
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/expires before the decision/);
  });
});

async function verify(bundle, now = fixedNow) {
  return verifyP5Bundle({
    manifestPath: bundle.manifestPath,
    trustPolicyPath: bundle.trustPolicyPath,
    now,
  });
}

async function createBundle(options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cinatoken-p5-"));
  const trustRoot = await mkdtemp(path.join(tmpdir(), "cinatoken-p5-trust-"));
  temporaryRoots.push(root);
  temporaryRoots.push(trustRoot);
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot);

  const keyPairs = new Map();
  const sharedApprovalKeyPair = options.reuseApprovalKeyMaterial
    ? generateKeyPairSync("ed25519")
    : null;
  const keys = REQUIRED_APPROVAL_ROLES.map((role) => {
    const pair = sharedApprovalKeyPair ?? generateKeyPairSync("ed25519");
    const keyId = `${role}-owner-v1`;
    keyPairs.set(keyId, pair);
    return {
      keyId,
      role,
      publicKeySpkiBase64url: pair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      notBefore: "2026-07-18T00:00:00.000Z",
      notAfter: "2026-07-21T00:00:00.000Z",
    };
  });
  const trustPolicy = {
    schemaVersion: 1,
    contract: TRUST_POLICY_CONTRACT,
    policyId: "staging-p5-v1",
    environment: "staging",
    validFrom: "2026-07-18T00:00:00.000Z",
    validUntil: "2026-07-21T00:00:00.000Z",
    maxClockSkewSeconds: 300,
    keys,
  };
  options.mutatePolicy?.(trustPolicy);

  const candidate = candidateFixture();
  options.mutateCandidate?.(candidate);
  const candidateDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(candidate), "utf8"),
  );
  const foundationCapture = foundationCaptureFixture(
    candidate,
    candidateDigestSha256,
  );
  options.mutateFoundationCapture?.(foundationCapture);
  const foundationRelativePath = "evidence/foundation-capture.json";
  const foundationPath = path.join(
    root,
    ...foundationRelativePath.split("/"),
  );
  const foundationBytes = Buffer.from(
    `${canonicalJson(foundationCapture)}\n`,
    "utf8",
  );
  await writeFile(foundationPath, foundationBytes);
  const foundationRecord = {
    path: foundationRelativePath,
    sha256: sha256Hex(foundationBytes),
    bytes: foundationBytes.length,
  };
  const evidencePaths = new Map();
  const records = [];
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    const evidence = {
      schemaVersion: 1,
      contract: EVIDENCE_CONTRACT,
      kind,
      environment: "staging",
      candidateDigestSha256,
      capturedAt,
      expiresAt,
      status: "pass",
      facts: factsFixture(kind, candidate, foundationCapture.binding),
    };
    options.mutateEvidence?.(kind, evidence);
    const relativePath = `evidence/${kind}.json`;
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const bytes = Buffer.from(`${canonicalJson(evidence)}\n`, "utf8");
    await writeFile(absolutePath, bytes);
    evidencePaths.set(kind, absolutePath);
    records.push({
      kind,
      path: relativePath,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      capturedAt: evidence.capturedAt,
      expiresAt: evidence.expiresAt,
    });
  }
  options.mutateArtifactRecords?.(records);

  const cohort = {
    kind: "synthetic",
    route: "/v1/chat/completions",
    streaming: false,
    customerTraffic: false,
    maxOperations: 100,
    tokenScopeSha256: "1".repeat(64),
    modelScopeSha256: "2".repeat(64),
    channelScopeSha256: "3".repeat(64),
    windowStartsAt: "2026-07-19T11:00:00.000Z",
    windowEndsAt: "2026-07-19T12:00:00.000Z",
  };
  options.mutateCohort?.(cohort);
  const subject = {
    policyId: trustPolicy.policyId,
    environment: "staging",
    decision: "isolated-staging-synthetic-canary",
    generatedAt,
    expiresAt,
    candidate,
    candidateDigestSha256,
    foundationCapture: foundationRecord,
    cohort,
    artifacts: records,
  };
  options.mutateSubject?.(subject);
  const subjectDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(subject), "utf8"),
  );
  const actualSignedAt = options.approvalSignedAt ?? signedAt;
  const actualApprovalExpiresAt = options.approvalExpiresAt ?? expiresAt;
  const approvals = REQUIRED_APPROVAL_ROLES.map((role) => {
    const keyId = `${role}-owner-v1`;
    const approval = {
      role,
      keyId,
      signedAt: actualSignedAt,
      expiresAt: actualApprovalExpiresAt,
      subjectDigestSha256,
      signatureBase64url: "",
    };
    approval.signatureBase64url = base64UrlEncode(
      signMessage(
        null,
        approvalMessage({
          policyId: subject.policyId,
          environment: subject.environment,
          role,
          keyId,
          subjectDigestSha256,
          signedAt: approval.signedAt,
          expiresAt: approval.expiresAt,
        }),
        keyPairs.get(keyId).privateKey,
      ),
    );
    return approval;
  });
  options.mutateApprovals?.(approvals);
  const manifest = {
    schemaVersion: 2,
    contract: MANIFEST_CONTRACT,
    subject,
    subjectDigestSha256,
    approvals,
  };
  options.mutateManifest?.(manifest);

  const manifestPath = path.join(root, "manifest.json");
  const trustPolicyPath = path.join(trustRoot, "trust-policy.json");
  await writeCanonical(manifestPath, manifest);
  await writeCanonical(trustPolicyPath, trustPolicy);
  await options.afterWrite?.({
    root,
    evidencePaths,
    foundationPath,
    manifestPath,
    trustPolicyPath,
  });
  return {
    root,
    manifestPath,
    trustPolicyPath,
    evidencePaths,
    foundationPath,
    foundationCaptureSha256: foundationCapture.foundationCaptureSha256,
    foundationArtifactSha256: foundationRecord.sha256,
  };
}

function candidateFixture() {
  return {
    repository: "cinagroup/cinatoken-rust",
    commitSha: "404ae9ad3d217194922692b585c967fe2ba2a086",
    goSourceCommit: "73652508abc5cb09214dde02d51d69d1d1ccc703",
    vibeSourceCommit: "918e97480ee44e357abe99bf33c27259d6ac7ebd",
    edgeWorkerVersionId: "edge-version-001",
    controllerWorkerVersionId: "controller-version-001",
    providerEgressWorkerVersionId: "egress-version-001",
    containerImageDigest: `sha256:${"4".repeat(64)}`,
    containerRuntimeBuildId: "a".repeat(64),
    containerImageProvenanceSha256: "b".repeat(64),
    containerSbomSha256: "5".repeat(64),
    d1DatabaseName: "cinatoken-rust-db-staging",
    d1DatabaseId: "c285553f-7f98-4ec2-b4d6-f84a3b409f3e",
    r2BucketName: "cinatoken-rust-files-staging",
    configKvNamespaceIdSha256: "6".repeat(64),
    controllerServiceName: "cinatoken-container-controller-staging",
    providerEgressServiceName: "cinatoken-container-egress-staging",
    doNamespaceIdSha256: "7".repeat(64),
    doBinding: "RELAY_SHARDS",
    doClass: "RelayShardContainer",
    containerClass: "RelayShardContainer",
    ringGeneration: 1,
    shardCount: 8,
    migrationHead: "0055_relay_container_shard_activation_campaigns.sql",
    migrationCount: 55,
    responseProtocolVersion: 3,
    statusContractVersion: 4,
    financialTerminalContractVersion: 2,
    terminalAckContractVersion: 3,
  };
}

function foundationCaptureFixture(candidate, candidateDigestSha256) {
  const evidenceFacts = {
    candidateFreeze: foundationEvidenceFactsFixture(
      "candidateFreeze",
      candidate,
    ),
    remoteInventory: foundationEvidenceFactsFixture(
      "remoteInventory",
      candidate,
    ),
  };
  const readbackKeys = [
    "edge-version",
    "edge-deployments",
    "controller-version",
    "controller-deployments",
    "provider-egress-version",
    "provider-egress-deployments",
    "d1-info",
    "r2-info",
    "kv-namespaces",
    "container-applications",
    "container-info",
    "container-instances",
    "container-deployments",
  ];
  const commands = readbackKeys.map((key, index) => ({
    key,
    status: "pass",
    transport: "cloudflare-api",
    requestSha256: sha256Hex(Buffer.from(`request:${index}`, "utf8")),
    outputSha256: sha256Hex(Buffer.from(`output:${index}`, "utf8")),
    outputBytes: 10,
    stderrSha256: null,
    stderrEmpty: true,
    expectedValuesPresent: true,
    expectedContainerImageDigestPresent:
      key === "container-info" || key === "container-deployments" ? true : null,
    itemCount: 1,
    paginationMode:
      key === "kv-namespaces"
        ? "page-number"
        : key === "container-applications" || key === "container-instances"
          ? "page-token"
          : "single-response",
    pageCount: 1,
    paginationEvidenceSha256: sha256Hex(
      Buffer.from(`pagination:${index}`, "utf8"),
    ),
    paginationComplete: true,
  }));
  const readback = {
    digestSha256: sha256Hex(Buffer.from(canonicalJson(commands), "utf8")),
    complete: true,
    paginationComplete: true,
    stderrEmpty: true,
    commands,
  };
  const subject = {
    mode: "live-readback",
    environment: "staging",
    decision: "not-proven",
    p5Eligible: false,
    productionEligible: false,
    customerTrafficEligible: false,
    foundationEvidenceReady: true,
    requestDigestSha256: "1".repeat(64),
    candidateDigestSha256,
    candidate,
    observationStartedAt: foundationObservationStartedAt,
    observationEndedAt: foundationObservationEndedAt,
    observationSeconds: 480,
    paginationComplete: true,
    readbackStable: true,
    before: structuredClone(readback),
    after: structuredClone(readback),
    sourceBundleDigestSha256: "2".repeat(64),
    sources: {
      status: "provided",
      capturedAt: foundationObservationEndedAt,
      paginationComplete: true,
      actionGates: "pass",
      r2Inventory: "pass",
      sbom: "pass",
      shardRegistry: "pass",
      traffic: "pass",
    },
    artifactInventorySha256: "8".repeat(64),
    blockers: [],
    evidenceFacts,
    safetyBoundary: {
      credentialsRead: true,
      credentialValuesEmitted: false,
      customerTrafficEligible: false,
      deployOrRollbackExecuted: false,
      networkReadbackPerformed: true,
      p5Eligible: false,
      productionEligible: false,
      providerRequestPerformed: false,
      remoteMutationPerformed: false,
      shellExecuted: false,
      sshOrContainerWakeExecuted: false,
      writesFiles: false,
    },
  };
  const foundationCaptureSha256 = sha256Hex(
    Buffer.from(canonicalJson(subject), "utf8"),
  );
  const binding = {
    foundationCaptureContract: FOUNDATION_CAPTURE_CONTRACT,
    foundationCollectorVersion: FOUNDATION_COLLECTOR_VERSION,
    foundationCollectorSha256,
    observationStartedAt: foundationObservationStartedAt,
    observationEndedAt: foundationObservationEndedAt,
    paginationComplete: true,
    foundationCaptureSha256,
  };
  return {
    schemaVersion: 1,
    contract: FOUNDATION_CAPTURE_CONTRACT,
    foundationCollectorVersion: FOUNDATION_COLLECTOR_VERSION,
    foundationCollectorSha256,
    foundationCaptureSha256,
    binding,
    subject,
  };
}

function foundationEvidenceFactsFixture(kind, candidate) {
  if (kind === "candidateFreeze") {
    return {
      repositoryCommit: candidate.commitSha,
      goSourceCommit: candidate.goSourceCommit,
      vibeSourceCommit: candidate.vibeSourceCommit,
      edgeWorkerVersionId: candidate.edgeWorkerVersionId,
      controllerWorkerVersionId: candidate.controllerWorkerVersionId,
      providerEgressWorkerVersionId: candidate.providerEgressWorkerVersionId,
      containerImageDigest: candidate.containerImageDigest,
      containerRuntimeBuildId: candidate.containerRuntimeBuildId,
      containerImageProvenanceSha256:
        candidate.containerImageProvenanceSha256,
      containerSbomSha256: candidate.containerSbomSha256,
      containerSignatureVerified: true,
      runtimeImageProvenanceVerified: true,
      unapprovedCriticalVulnerabilities: 0,
      unapprovedHighVulnerabilities: 0,
      allActionGatesFalse: true,
      shardActivationCampaign: shardActivationCampaignFixture(candidate),
      artifactInventorySha256: "8".repeat(64),
    };
  }
  if (kind === "remoteInventory") {
    return {
      accountIdSha256: "9".repeat(64),
      d1DatabaseName: candidate.d1DatabaseName,
      d1DatabaseId: candidate.d1DatabaseId,
      r2BucketName: candidate.r2BucketName,
      configKvNamespaceIdSha256: candidate.configKvNamespaceIdSha256,
      controllerServiceName: candidate.controllerServiceName,
      providerEgressServiceName: candidate.providerEgressServiceName,
      doNamespaceIdSha256: candidate.doNamespaceIdSha256,
      doBinding: candidate.doBinding,
      doClass: candidate.doClass,
      containerClass: candidate.containerClass,
      containerRuntimeBuildId: candidate.containerRuntimeBuildId,
      containerImageProvenanceSha256:
        candidate.containerImageProvenanceSha256,
      ringGeneration: candidate.ringGeneration,
      shardCount: candidate.shardCount,
      verifiedShardCount: candidate.shardCount,
      shardActivationCampaign: shardActivationCampaignFixture(candidate),
      unknownWriterCount: 0,
      unknownObjectCount: 0,
      customerTrafficCount: 0,
      environmentIsolationVerified: true,
    };
  }
  throw new Error(`unsupported foundation facts fixture: ${kind}`);
}

function shardActivationCampaignFixture(candidate) {
  return {
    campaignContract:
      "cinatoken-relay-container-shard-activation-campaign-v1",
    state: "sealed_complete",
    campaignId: "c".repeat(64),
    campaignDigestSha256: "d".repeat(64),
    controllerVersionId: candidate.controllerWorkerVersionId,
    actionGateInventorySha256: "9".repeat(64),
    actionGateCount: 22,
    allActionGatesFalse: true,
    foundationManifestSha256: "6".repeat(64),
    runtimeBuildId: candidate.containerRuntimeBuildId,
    ringGeneration: candidate.ringGeneration,
    shardCount: candidate.shardCount,
    shardContractVersion: 1,
    runtimeProtocolVersion: 1,
    runtimeContractVersion: 1,
    activationGeneration: 1,
    environment: "staging",
    claimedShardCount: candidate.shardCount,
    consumedShardCount: candidate.shardCount,
    sealReason: "complete",
    sealDetailCode: "all_shards_consumed",
    lastConsumptionDigestSha256: "a".repeat(64),
    sealedAt: Math.floor(Date.parse("2026-07-19T09:49:00.000Z") / 1_000),
    receiptCount: candidate.shardCount,
    receiptSetSha256: "b".repeat(64),
  };
}

function factsFixture(kind, candidate, foundationBinding) {
  switch (kind) {
    case "candidate-freeze":
      return {
        ...foundationEvidenceFactsFixture("candidateFreeze", candidate),
        ...foundationBinding,
      };
    case "remote-inventory":
      return {
        ...foundationEvidenceFactsFixture("remoteInventory", candidate),
        ...foundationBinding,
      };
    case "reader-first-rollout":
      return {
        providerEgressDeployedBeforeController: true,
        controllerDeployedBeforeEdge: true,
        readersDeployedBeforeWriters: true,
        activeShardCount: candidate.shardCount,
        verifiedShardCount: candidate.shardCount,
        legacyReaderShardCount: 0,
        unknownShardCount: 0,
        newResponseWriteCount: 0,
        allActionGatesFalse: true,
        publicInternalRouteStatus: 404,
        mixedVersionMode: "n-n-1",
        versionSkewFaultsPassed: true,
        serviceBindingVersionPinned: true,
      };
    case "schema-readback":
      return {
        migrationHead: candidate.migrationHead,
        migrationCount: 55,
        tableCount: 62,
        incrementalColumnCount: 771,
        keyIndexCount: 91,
        schemaFingerprintSha256: "a".repeat(64),
        businessFingerprintBeforeSha256: "b".repeat(64),
        businessFingerprintAfterSha256: "b".repeat(64),
        negativeProbeCount: 24,
        negativeProbeFailures: 0,
        oldWriterRejectedBeforeProvider: true,
        providerCallDelta: 0,
        financialMutationDelta: 0,
      };
    case "lifecycle-fault-campaign":
      return {
        scenarioResults: Object.fromEntries(
          REQUIRED_LIFECYCLE_SCENARIOS.map((scenario) => [scenario, "pass"]),
        ),
        providerCallDelta: 0,
        financialMutationDelta: 0,
        duplicateProviderCalls: 0,
        duplicateFinancialTerminals: 0,
        unresolvedOperations: 0,
        quarantinedOperations: 2,
        maxColdStartMs: 2500,
      };
    case "response-financial-fault-campaign":
      return {
        successCases: 4,
        typedErrorCases: 4,
        httpErrorCases: 4,
        invalidBodyCases: 4,
        faultInjectionPointCount: 32,
        faultInjectionPassCount: 32,
        providerCalls: 16,
        providerOperations: 16,
        duplicateProviderCalls: 0,
        settledOperations: 4,
        refundedOperations: 12,
        recoveryOperations: 4,
        duplicateFinancialTerminals: 0,
        duplicateOutboxRows: 0,
        requestAccountingOnRefund: 0,
        unexplainedProviderDelta: 0,
        unexplainedFinancialDeltaMinorUnits: "0",
        r2OrphansUnclassified: 0,
        clientReplayMismatches: 0,
      };
    case "cross-layer-provenance":
      return {
        traceCount: 16,
        completeTraceCount: 16,
        missingSegmentCount: 0,
        identityMismatchCount: 0,
        segments: REQUIRED_PROVENANCE_SEGMENTS,
        redactionFindings: 0,
      };
    case "load-cost-slo":
      return {
        durationSeconds: 3600,
        requestCount: 5000,
        rust5xxDeltaBasisPoints: 10,
        nonStreamP95OverheadMs: 180,
        d1WriteFailures: 0,
        d1OverloadErrors: 0,
        resourceLimitErrors: 0,
        alertDrillsAttempted: 3,
        alertDrillsDelivered: 3,
        currentTrafficCostApproved: true,
        doubleTrafficCostApproved: true,
        fiveXTrafficCostApproved: true,
        unboundedBacklogCount: 0,
      };
    case "rollback-rehearsal":
      return {
        disableFirst: true,
        allActionGatesFalseReadback: true,
        newRustAdmissionsAfterDisable: 0,
        inflightOperations: 5,
        classifiedInflightOperations: 5,
        providerResends: 0,
        duplicateFinancialMutations: 0,
        goVpsAuthorityRestored: true,
        p3ReadersRetained: true,
        migration0054Retained: true,
        evidenceRetained: true,
        rollbackDurationSeconds: 180,
      };
    case "security-privacy-review":
      return {
        replacementCredentialVerified: true,
        leastPrivilegeReadbackVerified: true,
        secretValueFindings: 0,
        unredactedPayloadFindings: 0,
        criticalFindings: 0,
        unapprovedHighFindings: 0,
        retentionApproved: true,
        privacyApproved: true,
        incidentOwnerAssigned: true,
      };
    default:
      throw new Error(`unsupported fixture kind: ${kind}`);
  }
}

async function writeCanonical(file, value) {
  await writeFile(file, `${canonicalJson(value)}\n`, "utf8");
}
