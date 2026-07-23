import { afterAll, describe, expect, test } from "bun:test";
import {
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RING_TRANSITION_APPROVAL_DOMAIN,
  RING_TRANSITION_DECISION,
  RING_TRANSITION_EVIDENCE_CONTRACT,
  RING_TRANSITION_EVIDENCE_KINDS,
  RING_TRANSITION_MANIFEST_CONTRACT,
  RING_TRANSITION_TRUST_POLICY_CONTRACT,
  ringTransitionApprovalMessage,
  routingContractDigestSha256,
  verifyRingTransitionBundle,
} from "../tools/relay_container_ring_transition_contract.mjs";
import {
  APPROVAL_DOMAIN as P5_APPROVAL_DOMAIN,
  REQUIRED_APPROVAL_ROLES,
  canonicalJson,
  p5CandidateDigestSha256,
  sha256Hex,
} from "../tools/relay_container_p5_evidence_contract.mjs";

const fixedNow = new Date("2026-07-23T10:00:00.000Z");
const fixedTimeline = timelineFor(fixedNow);
const generatedAt = fixedTimeline.generatedAt;
const signedAt = fixedTimeline.signedAt;
const admissionStartedAt = fixedTimeline.admissionStartedAt;
const admissionUntil = fixedTimeline.admissionUntil;
const expiresAt = fixedTimeline.expiresAt;
const childExpiresAt = fixedTimeline.evidenceExpiresAt;
const temporaryRoots = [];

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Relay Container adjacent ring transition signed contract", () => {
  test("validates a review-only isolated staging transition from real artifacts", async () => {
    const bundle = await createBundle();
    const result = await verify(bundle);

    expect(result.ok).toBe(true);
    expect(result.structurallyValid).toBe(true);
    expect(result.decision).toBe(
      "eligible-for-isolated-staging-adjacent-ring-transition-review",
    );
    expect(result.isolatedStagingTransitionReviewEligible).toBe(true);
    expect(result.approvalRoles).toEqual(REQUIRED_APPROVAL_ROLES);
    expect(result.policyDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.approvalKeys).toHaveLength(5);
    expect(result.approvalKeys.every((item) => /^[0-9a-f]{64}$/.test(item.publicKeySha256))).toBe(true);
    expect(result.artifacts.map((item) => item.kind)).toEqual(
      RING_TRANSITION_EVIDENCE_KINDS,
    );
    expect(result.transition).toMatchObject({
      previousRingGeneration: 1,
      previousShardCount: 8,
      currentRingGeneration: 2,
      currentShardCount: 12,
      admissionWindowSeconds: 600,
      maxInstances: 12,
    });
    expect(result.plan.controllerFirst.vars).toEqual({
      CONTAINER_RING_GENERATION: "2",
      CONTAINER_SHARD_COUNT: "12",
      CONTAINER_PREVIOUS_RING_GENERATION: "1",
      CONTAINER_PREVIOUS_SHARD_COUNT: "8",
      CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT: "1784801400",
      CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL: "1784802000",
    });
    expect(result.plan.edgeSecond.vars).toEqual({
      CONTAINER_SCHEDULER_RING_GENERATION: "2",
      CONTAINER_SCHEDULER_SHARD_COUNT: "12",
    });
    expect(result.plan.executableDeployCommand).toBeNull();
    expect(result.planDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const field of [
      "deployAuthorized",
      "controllerDeployAuthorized",
      "edgeDeployAuthorized",
      "remoteMutationAuthorized",
      "remoteMutationPerformedByVerifier",
      "credentialsReadByVerifier",
      "customerTrafficAuthorized",
      "customerTrafficEligible",
      "productionCutoverAuthorized",
      "productionEligible",
      "providerCallsAuthorized",
    ]) {
      expect(result[field]).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain("privateKey");
    expect(JSON.stringify(result)).not.toContain("wrangler deploy");
  });

  test("bundle verification has no evidence-verifier injection seam", async () => {
    const bundle = await createBundle();
    const result = await verify(bundle);
    expect(result.ok).toBe(true);

    const source = await readFile(
      path.resolve(import.meta.dir, "../tools/relay_container_ring_transition_contract.mjs"),
      "utf8",
    );
    expect(source).not.toContain("p5Verifier");
    expect(source).not.toContain("inspectRingTransitionManifest");
  });

  test("rejects non-adjacent, non-expanding, candidate-drifted, or under-capacity rings", async () => {
    for (const mutateSubject of [
      (subject) => {
        subject.transition.currentRingGeneration = 3;
      },
      (subject) => {
        subject.transition.currentShardCount = 8;
      },
      (subject) => {
        subject.transition.currentShardCount = 13;
      },
      (subject) => {
        subject.transition.maxInstances = 11;
      },
    ]) {
      const bundle = await createBundle({ mutateSubject });
      await expect(verify(bundle)).rejects.toThrow(
        /adjacent|expand|candidate shard count|maxInstances/,
      );
    }
  });

  test("rejects elapsed, overlong, fractional, or insufficient-lead admission windows", async () => {
    for (const mutateSubject of [
      (subject) => {
        subject.transition.admissionStartedAt = "2026-07-23T10:02:00.000Z";
      },
      (subject) => {
        subject.transition.admissionUntil = "2026-07-23T10:25:01.000Z";
      },
      (subject) => {
        subject.transition.admissionStartedAt = "2026-07-23T10:10:00.001Z";
      },
      (subject) => {
        subject.transition.admissionUntil = "2026-07-23T10:30:00.000Z";
      },
    ]) {
      const bundle = await createBundle({ mutateSubject });
      await expect(verify(bundle)).rejects.toThrow(
        /lead time|admission window|whole second|signed decision window/,
      );
    }
  });

  test("rejects routing identity drift and safety authority escalation", async () => {
    const routingDrift = await createBundle({
      mutateSubject: (subject) => {
        subject.transition.routingContractDigestSha256 = "0".repeat(64);
      },
    });
    await expect(verify(routingDrift)).rejects.toThrow(/routing contract digest mismatch/);

    for (const field of [
      "customerTrafficAuthorized",
      "productionCutoverAuthorized",
      "remoteMutationAuthorized",
      "providerCallsAuthorized",
      "secretRotationAuthorized",
      "generationRollbackAuthorized",
      "goVpsShutdownAuthorized",
    ]) {
      const bundle = await createBundle({
        mutateSubject: (subject) => {
          subject.safetyBoundary[field] = true;
        },
      });
      await expect(verify(bundle)).rejects.toThrow(new RegExp(field));
    }
  });

  test("rejects old-ring artifact, schema, protocol, or key rotation hidden in expansion", async () => {
    for (const mutateFacts of [
      (facts) => {
        facts.containerImageDigest = `sha256:${"0".repeat(64)}`;
      },
      (facts) => {
        facts.migrationCount = 57;
      },
      (facts) => {
        facts.statusContractVersion = 3;
      },
      (facts) => {
        facts.routingKeyId = "routing-staging-v2";
      },
      (facts) => {
        facts.authorityKeyFingerprintSha256 = "f".repeat(64);
      },
    ]) {
      const bundle = await createBundle({
        mutateArtifact: (kind, artifact) => {
          if (kind === "previous-ring-readback") mutateFacts(artifact.facts);
        },
      });
      await expect(verify(bundle)).rejects.toThrow(/\[baseline\].*mismatch/);
    }
  });

  test("rejects candidate-foundation or Go/VPS fallback drift", async () => {
    const cases = [
      {
        mutateArtifact: (kind, artifact) => {
          if (kind === "candidate-foundation") {
            artifact.facts.candidateDigestSha256 = "0".repeat(64);
          }
        },
        pattern: /foundation.*candidate digest mismatch/,
      },
      {
        mutateArtifact: (kind, artifact) => {
          if (kind === "candidate-foundation") {
            artifact.facts.buildProvenanceSha256 = "0".repeat(64);
          }
        },
        pattern: /build provenance mismatch/,
      },
      {
        mutateArtifact: (kind, artifact) => {
          if (kind === "go-vps-fallback-readiness") {
            artifact.facts.rustCommitSha = "0".repeat(40);
          }
        },
        pattern: /Rust commit mismatch/,
      },
      {
        mutateArtifact: (kind, artifact) => {
          if (kind === "go-vps-fallback-readiness") {
            artifact.expiresAt = "2026-07-23T10:24:59.000Z";
          }
        },
        pattern: /evidence expires before the decision/,
      },
      {
        mutateArtifact: (kind, artifact) => {
          if (kind === "go-vps-fallback-readiness") {
            artifact.facts.ingressDrainAuthorized = true;
          }
        },
        pattern: /ingress drain authorization mismatch/,
      },
    ];
    for (const options of cases) {
      const bundle = await createBundle(options);
      await expect(verify(bundle)).rejects.toThrow(options.pattern);
    }
  });

  test("rejects missing, reordered, shared, expired, or tampered approvals", async () => {
    const missing = await createBundle({
      mutateApprovals: (approvals) => approvals.pop(),
    });
    await expect(verify(missing)).rejects.toThrow(/exactly five approvals/);

    const reordered = await createBundle({
      mutateApprovals: (approvals) => approvals.reverse(),
    });
    await expect(verify(reordered)).rejects.toThrow(/role order mismatch/);

    const duplicateKey = await createBundle({
      mutateApprovals: (approvals) => {
        approvals[1].keyId = approvals[0].keyId;
      },
    });
    await expect(verify(duplicateKey)).rejects.toThrow(/approval keys must be distinct|not trusted/);

    const sharedPublicKey = await createBundle({ reuseApprovalKeyMaterial: true });
    await expect(verify(sharedPublicKey)).rejects.toThrow(/cryptographically distinct/);

    const expired = await createBundle({
      approvalExpiresAt: "2026-07-23T10:24:59.000Z",
    });
    await expect(verify(expired)).rejects.toThrow(/expires before/);

    const tampered = await createBundle({
      mutateApprovals: (approvals) => {
        approvals[0].signatureBase64url = "A".repeat(86);
      },
    });
    await expect(verify(tampered)).rejects.toThrow(/signature verification failed|canonical bytes/);
  });

  test("rejects P5-domain signature replay and approvals at admission start", async () => {
    expect(RING_TRANSITION_APPROVAL_DOMAIN).not.toBe(P5_APPROVAL_DOMAIN);
    const replay = await createBundle({ approvalDomain: P5_APPROVAL_DOMAIN });
    await expect(verify(replay)).rejects.toThrow(/signature verification failed/);

    const late = await createBundle({ approvalSignedAt: admissionStartedAt });
    await expect(verify(late)).rejects.toThrow(/must precede admission start/);
  });

  test("requires canonical non-hard-linked files and an external trust policy", async () => {
    const nonCanonical = await createBundle();
    const parsed = JSON.parse(await readFile(nonCanonical.manifestPath, "utf8"));
    await writeFile(nonCanonical.manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await expect(verify(nonCanonical)).rejects.toThrow(/canonical JSON/);

    const internalPolicy = await createBundle({ trustPolicyInsideBundle: true });
    await expect(verify(internalPolicy)).rejects.toThrow(/external to the manifest bundle/);

    const hardLinked = await createBundle();
    const secondLink = path.join(path.dirname(hardLinked.manifestPath), "manifest-copy.json");
    try {
      await link(hardLinked.manifestPath, secondLink);
    } catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) return;
      throw error;
    }
    await expect(verify(hardLinked)).rejects.toThrow(/must not be hard-linked/);
  });

  test("reads and hashes every canonical evidence artifact", async () => {
    const tampered = await createBundle({
      afterWrite: async ({ artifactPaths }) => {
        await writeFile(artifactPaths.get("capacity-readback"), "{}\n", "utf8");
      },
    });
    await expect(verify(tampered)).rejects.toThrow(/byte count mismatch|digest mismatch/);

    const wrongCandidate = await createBundle({
      mutateArtifact: (kind, artifact) => {
        if (kind === "observability-plan") {
          artifact.candidateDigestSha256 = "0".repeat(64);
        }
      },
    });
    await expect(verify(wrongCandidate)).rejects.toThrow(/candidate digest mismatch/);
  });

  test("rejects non-ready capacity, observability, rollback, or revocation evidence", async () => {
    const cases = [
      ["capacity-readback", (facts) => { facts.readyShardCount = 11; }, /ready shard count mismatch/],
      ["observability-plan", (facts) => { facts.syntheticOnly = false; }, /synthetic-only scope mismatch/],
      ["rollback-packet", (facts) => { facts.goVpsTrafficAuthority = false; }, /traffic authority mismatch/],
      ["credential-revocation", (facts) => { facts.revoked = false; }, /revoked mismatch/],
    ];
    for (const [targetKind, mutateFacts, pattern] of cases) {
      const bundle = await createBundle({
        mutateArtifact: (kind, artifact) => {
          if (kind === targetKind) mutateFacts(artifact.facts);
        },
      });
      await expect(verify(bundle)).rejects.toThrow(pattern);
    }
  });

  test("rejects unknown fields and subject digest drift", async () => {
    const unknown = await createBundle({
      mutateSubject: (subject) => {
        subject.deployAuthorized = false;
      },
    });
    await expect(verify(unknown)).rejects.toThrow(/unknown or missing fields/);

    const digestDrift = await createBundle({
      mutateManifest: (manifest) => {
        manifest.subjectDigestSha256 = "0".repeat(64);
      },
    });
    await expect(verify(digestDrift)).rejects.toThrow(/subject digest mismatch/);
  });
});

describe("ring transition verifier CLI", () => {
  test("verifies a real seven-artifact packet without credential access", async () => {
    const bundle = await createBundle({ liveNow: new Date() });
    const marker = "must-not-appear-in-verification-output";
    const result = runCli(
      [
        "--manifest",
        bundle.manifestPath,
        "--trust-policy",
        bundle.trustPolicyPath,
        "--json",
      ],
      minimalChildEnv({ CLOUDFLARE_API_TOKEN: marker }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(marker);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.isolatedStagingTransitionReviewEligible).toBe(true);
    expect(parsed.artifacts).toHaveLength(7);
    expect(parsed.safetyBoundary).toMatchObject({
      credentialsReadByVerifier: false,
      networkRequestsPerformedByVerifier: false,
      filesWrittenByVerifier: false,
      shellCommandsExecutedByVerifier: false,
      remoteMutationPerformedByVerifier: false,
    });
  });

  test("describe is deterministic, credential-free, and non-authorizing", () => {
    const marker = "must-not-appear-in-output";
    const first = runCli(["--describe", "--json"], minimalChildEnv({
      CLOUDFLARE_API_TOKEN: marker,
      CINATOKEN_P5_READBACK_TOKEN: marker,
    }));
    const second = runCli(["--describe", "--json"], minimalChildEnv());

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).not.toContain(marker);
    const result = JSON.parse(first.stdout);
    expect(result.constraints).toMatchObject({
      credentialsRead: false,
      networkRequests: false,
      writesFiles: false,
      executesShellCommands: false,
      emitsExecutableDeployCommand: false,
      authorizesRemoteMutation: false,
      authorizesCustomerTraffic: false,
      authorizesProductionCutover: false,
    });
  });

  test("the verifier import path contains no env, network, subprocess, or write primitive", async () => {
    for (const file of [
      "tools/relay_container_ring_transition_contract.mjs",
      "tools/verify_relay_container_ring_transition.mjs",
    ]) {
      const source = await readFile(path.resolve(import.meta.dir, "..", file), "utf8");
      expect(source).not.toMatch(/process\.env|fetch\s*\(|node:child_process|Bun\.spawn/);
      expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|runBoundedSubprocess/);
    }
  });

  test("rejects unknown, repeated, incomplete, and describe-path arguments", () => {
    for (const args of [
      ["--unknown"],
      ["--manifest", "a", "--manifest", "b"],
      ["--manifest", "a"],
      ["--describe", "--manifest", "a"],
      ["--json", "--json", "--describe"],
      ["--describe", "--describe"],
    ]) {
      const result = runCli(args, {});
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[input]");
    }
  });
});

async function verify(bundle) {
  return verifyRingTransitionBundle({
    manifestPath: bundle.manifestPath,
    trustPolicyPath: bundle.trustPolicyPath,
    now: fixedNow,
  });
}

async function createBundle(options = {}) {
  const timeline = timelineFor(options.liveNow ?? fixedNow);
  const root = await mkdtemp(path.join(tmpdir(), "cinatoken-ring-transition-"));
  const trustRoot = options.trustPolicyInsideBundle
    ? root
    : await mkdtemp(path.join(tmpdir(), "cinatoken-ring-transition-trust-"));
  temporaryRoots.push(root);
  if (trustRoot !== root) temporaryRoots.push(trustRoot);
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot);

  const sharedPair = options.reuseApprovalKeyMaterial
    ? generateKeyPairSync("ed25519")
    : null;
  const keyPairs = new Map();
  const keys = REQUIRED_APPROVAL_ROLES.map((role) => {
    const pair = sharedPair ?? generateKeyPairSync("ed25519");
    const keyId = `${role}-transition-v1`;
    keyPairs.set(keyId, pair);
    return {
      keyId,
      role,
      publicKeySpkiBase64url: pair.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
      notBefore: timeline.policyValidFrom,
      notAfter: timeline.policyValidUntil,
    };
  });
  const trustPolicy = {
    schemaVersion: 1,
    contract: RING_TRANSITION_TRUST_POLICY_CONTRACT,
    policyId: "staging-ring-transition-v1",
    environment: "staging",
    validFrom: timeline.policyValidFrom,
    validUntil: timeline.policyValidUntil,
    maxClockSkewSeconds: 60,
    keys,
  };
  options.mutatePolicy?.(trustPolicy);

  const candidate = candidateFixture();
  const candidateDigestSha256 = p5CandidateDigestSha256(candidate);
  const transition = {
    previousRingGeneration: 1,
    previousShardCount: 8,
    currentRingGeneration: 2,
    currentShardCount: 12,
    admissionStartedAt: timeline.admissionStartedAt,
    admissionUntil: timeline.admissionUntil,
    cutoffSafetyMarginSeconds: 5,
    maxInstances: 12,
    routingContractDigestSha256: routingContractDigestSha256(),
    routingKeyId: "routing-staging-v1",
    routingKeyFingerprintSha256: "d".repeat(64),
    authorityKeyId: "authority-staging-v1",
    authorityKeyFingerprintSha256: "e".repeat(64),
  };
  const artifactPaths = new Map();
  const artifactRecords = [];
  for (const [index, kind] of RING_TRANSITION_EVIDENCE_KINDS.entries()) {
    const artifact = {
      schemaVersion: 1,
      contract: RING_TRANSITION_EVIDENCE_CONTRACT,
      kind,
      environment: "staging",
      candidateDigestSha256,
      capturedAt: new Date(
        new Date(timeline.artifactCapturedBase).getTime() + index * 1000,
      ).toISOString(),
      expiresAt: timeline.evidenceExpiresAt,
      status: "pass",
      facts: artifactFactsFixture(kind, candidate, transition, timeline),
    };
    options.mutateArtifact?.(kind, artifact);
    const artifactPath = path.join(evidenceRoot, `${kind}.json`);
    const bytes = Buffer.from(`${canonicalJson(artifact)}\n`, "utf8");
    await writeFile(artifactPath, bytes);
    artifactPaths.set(kind, artifactPath);
    artifactRecords.push({
      kind,
      path: `evidence/${kind}.json`,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      capturedAt: artifact.capturedAt,
      expiresAt: artifact.expiresAt,
    });
  }
  options.mutateArtifactRecords?.(artifactRecords);
  const subject = {
    policyId: trustPolicy.policyId,
    environment: "staging",
    decision: RING_TRANSITION_DECISION,
    generatedAt: timeline.generatedAt,
    expiresAt: timeline.expiresAt,
    candidate,
    candidateDigestSha256,
    transition,
    cohort: {
      kind: "synthetic",
      route: "/v1/chat/completions",
      streaming: false,
      customerTraffic: false,
      paidProviderCalls: false,
      maxOperations: 100,
      tenantScopeSha256: "8".repeat(64),
      tokenScopeSha256: "9".repeat(64),
    },
    artifacts: artifactRecords,
    safetyBoundary: {
      isolatedStagingOnly: true,
      customerTrafficAuthorized: false,
      productionCutoverAuthorized: false,
      remoteMutationAuthorized: false,
      providerCallsAuthorized: false,
      credentialMaterialIncluded: false,
      secretRotationAuthorized: false,
      generationRollbackAuthorized: false,
      goVpsShutdownAuthorized: false,
    },
  };
  options.mutateSubject?.(subject);
  subject.candidateDigestSha256 = options.keepCandidateDigest
    ? subject.candidateDigestSha256
    : p5CandidateDigestSha256(subject.candidate);

  const subjectDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(subject), "utf8"),
  );
  const actualSignedAt = options.approvalSignedAt ?? timeline.signedAt;
  const approvalExpiresAt = options.approvalExpiresAt ?? timeline.expiresAt;
  const approvals = REQUIRED_APPROVAL_ROLES.map((role) => {
    const keyId = `${role}-transition-v1`;
    const approval = {
      role,
      keyId,
      signedAt: actualSignedAt,
      expiresAt: approvalExpiresAt,
      subjectDigestSha256,
      signatureBase64url: "",
    };
    const message =
      options.approvalDomain === P5_APPROVAL_DOMAIN
        ? p5DomainApprovalMessage({
            policyId: subject.policyId,
            environment: subject.environment,
            role,
            keyId,
            subjectDigestSha256,
            signedAt: approval.signedAt,
            expiresAt: approval.expiresAt,
          })
        : ringTransitionApprovalMessage({
            policyId: subject.policyId,
            environment: subject.environment,
            role,
            keyId,
            subjectDigestSha256,
            signedAt: approval.signedAt,
            expiresAt: approval.expiresAt,
          });
    approval.signatureBase64url = signMessage(
      null,
      message,
      keyPairs.get(keyId).privateKey,
    ).toString("base64url");
    return approval;
  });
  options.mutateApprovals?.(approvals);
  const manifest = {
    schemaVersion: 1,
    contract: RING_TRANSITION_MANIFEST_CONTRACT,
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
    manifestPath,
    trustPolicyPath,
    artifactPaths,
  });
  return { root, manifestPath, trustPolicyPath, artifactPaths };
}

function artifactFactsFixture(kind, candidate, transition, timeline) {
  switch (kind) {
    case "candidate-foundation":
      return {
        candidateDigestSha256: p5CandidateDigestSha256(candidate),
        foundationCaptureSha256: "c".repeat(64),
        candidateFreezeEvidenceSha256: "d".repeat(64),
        sourceAuditSha256: "e".repeat(64),
        buildProvenanceSha256: candidate.containerImageProvenanceSha256,
        remotePromotionEvidenceClaimed: false,
        transitionEvidenceClaimed: false,
      };
    case "previous-ring-readback":
      return {
        ringGeneration: 1,
        shardCount: 8,
        rustCommitSha: candidate.commitSha,
        edgeWorkerVersionId: "edge-version-001",
        controllerWorkerVersionId: "controller-version-001",
        edgeDeploymentSetSha256: "0".repeat(64),
        controllerDeploymentSetSha256: "1".repeat(64),
        containerImageDigest: candidate.containerImageDigest,
        containerRuntimeBuildId: candidate.containerRuntimeBuildId,
        containerImageProvenanceSha256:
          candidate.containerImageProvenanceSha256,
        containerSbomSha256: candidate.containerSbomSha256,
        providerEgressWorkerVersionId:
          candidate.providerEgressWorkerVersionId,
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
        migrationHead: candidate.migrationHead,
        migrationCount: candidate.migrationCount,
        responseProtocolVersion: candidate.responseProtocolVersion,
        statusContractVersion: candidate.statusContractVersion,
        financialTerminalContractVersion:
          candidate.financialTerminalContractVersion,
        terminalAckContractVersion: candidate.terminalAckContractVersion,
        routingKeyId: transition.routingKeyId,
        routingKeyFingerprintSha256:
          transition.routingKeyFingerprintSha256,
        authorityKeyId: transition.authorityKeyId,
        authorityKeyFingerprintSha256:
          transition.authorityKeyFingerprintSha256,
      };
    case "capacity-readback":
      return {
        currentRingGeneration: transition.currentRingGeneration,
        currentShardCount: transition.currentShardCount,
        maxInstances: transition.maxInstances,
        readyShardCount: transition.currentShardCount,
        controllerWorkerVersionId: candidate.controllerWorkerVersionId,
        containerRuntimeBuildId: candidate.containerRuntimeBuildId,
        capacityAllocationSha256: "2".repeat(64),
      };
    case "observability-plan":
      return {
        dashboardConfigSha256: "3".repeat(64),
        alertPolicySha256: "4".repeat(64),
        evidenceSinkSha256: "5".repeat(64),
        abortOwner: "operations-primary",
        syntheticOnly: true,
      };
    case "rollback-packet":
      return {
        goVpsTrafficAuthority: true,
        goVpsSchedulerAuthority: true,
        controllerDrainRetained: true,
        generationRollbackAuthorized: false,
        disableRustAdmissionPlanSha256: "6".repeat(64),
        forwardRepairPlanSha256: "7".repeat(64),
      };
    case "credential-revocation":
      return {
        revoked: true,
        revokedAt: timeline.revokedAt,
        revocationReadbackSha256: "8".repeat(64),
        replacementCredentialIdentitySha256: "9".repeat(64),
        scopeAuditSha256: "a".repeat(64),
        secretValueIncluded: false,
      };
    case "go-vps-fallback-readiness":
      return {
        authority: "go-vps",
        goSourceCommit: candidate.goSourceCommit,
        rustCommitSha: candidate.commitSha,
        trafficRollbackReady: true,
        schedulerAuthorityRetained: true,
        ingressDrainAuthorized: false,
        processShutdownAuthorized: false,
        protocolScopeSha256: "b".repeat(64),
      };
    default:
      throw new Error(`unknown test artifact kind ${kind}`);
  }
}

function candidateFixture() {
  return {
    repository: "cinagroup/cinatoken-rust",
    commitSha: "404ae9ad3d217194922692b585c967fe2ba2a086",
    goSourceCommit: "73652508abc5cb09214dde02d51d69d1d1ccc703",
    vibeSourceCommit: "918e97480ee44e357abe99bf33c27259d6ac7ebd",
    edgeWorkerVersionId: "edge-version-002",
    controllerWorkerVersionId: "controller-version-002",
    providerEgressWorkerVersionId: "egress-version-002",
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
    ringGeneration: 2,
    shardCount: 12,
    migrationHead: "0058_relay_http_stream_client_abort_watchdogs.sql",
    migrationCount: 58,
    responseProtocolVersion: 3,
    statusContractVersion: 4,
    financialTerminalContractVersion: 2,
    terminalAckContractVersion: 3,
  };
}

function p5DomainApprovalMessage({
  policyId,
  environment,
  role,
  keyId,
  subjectDigestSha256,
  signedAt,
  expiresAt,
}) {
  return Buffer.from(
    [
      P5_APPROVAL_DOMAIN,
      policyId,
      environment,
      role,
      keyId,
      subjectDigestSha256,
      signedAt,
      expiresAt,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function writeCanonical(file, value) {
  await writeFile(file, `${canonicalJson(value)}\n`, "utf8");
}

function runCli(args, env) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/verify_relay_container_ring_transition.mjs",
      ...args,
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

function minimalChildEnv(extra = {}) {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
    "ComSpec",
    "TEMP",
    "TMP",
    "WINDIR",
    "HOME",
  ];
  const env = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

function timelineFor(now) {
  const baseMs = Math.floor(now.getTime() / 1000) * 1000;
  const at = (offsetSeconds) => new Date(baseMs + offsetSeconds * 1000).toISOString();
  return {
    policyValidFrom: at(-3600),
    policyValidUntil: at(24 * 60 * 60),
    revokedAt: at(-20 * 60),
    artifactCapturedBase: at(-13 * 60),
    generatedAt: at(-10 * 60),
    signedAt: at(-5 * 60),
    admissionStartedAt: at(10 * 60),
    admissionUntil: at(20 * 60),
    expiresAt: at(25 * 60),
    evidenceExpiresAt: at(30 * 60),
  };
}
