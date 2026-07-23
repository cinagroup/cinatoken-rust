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
  RING_TRANSITION_AUTHORIZATION_APPROVAL_DOMAIN,
  RING_TRANSITION_AUTHORIZATION_DECISION,
  RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
  RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS,
  RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT,
  RING_TRANSITION_AUTHORIZATION_RESULT,
  RING_TRANSITION_AUTHORIZATION_ROLES,
  RING_TRANSITION_AUTHORIZATION_TRUST_POLICY_CONTRACT,
  ringTransitionAuthorizationApprovalMessage,
  verifyRingTransitionMutationAuthorization,
} from "../tools/relay_container_ring_transition_authorization_contract.mjs";
import {
  collectRingTransitionDeploymentSetReadback,
  deploymentSetDigestSha256,
  normalizeDeploymentApiResponse,
} from "../tools/relay_container_ring_transition_deployment_set_collector.mjs";
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
    expect(result.manifestDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.serviceIdentities).toEqual({
      edgeWorker: "cinatoken-rust-api-staging",
      controllerWorker: "cinatoken-container-controller-staging",
      providerEgressWorker: "cinatoken-container-egress-staging",
    });
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

describe("Relay Container adjacent ring transition mutation authorization", () => {
  test("verifies the signed staging scope without granting remote mutation", async () => {
    const transitionBundle = await createBundle();
    const bundle = await createAuthorizationBundle(transitionBundle);
    const result = await verifyAuthorization(bundle);

    expect(result.ok).toBe(true);
    expect(result.decision).toBe(RING_TRANSITION_AUTHORIZATION_RESULT);
    expect(result.offlineSignedAuthorizationVerified).toBe(true);
    expect(result.signedWorkerDeploymentScopeApproved).toBe(true);
    expect(result.trustedPolicyAnchorVerified).toBe(false);
    expect(result.runnerTrustedPolicyAnchorRequired).toBe(true);
    expect(result.remoteMutationAuthorized).toBe(false);
    expect(result.workerDeploymentMutationAuthorized).toBe(false);
    expect(result.singleExecutionAuthorized).toBe(false);
    expect(result.atomicRemoteClaimRequired).toBe(true);
    expect(result.authenticatedT1ReadbackRequired).toBe(true);
    expect(result.authenticatedPostMutationReadbackRequired).toBe(true);
    expect(result.cloudflareNativeAtomicCasClaimed).toBe(false);
    expect(result.mutationPerformedByVerifier).toBe(false);
    expect(result.approvalRoles).toEqual(
      RING_TRANSITION_AUTHORIZATION_ROLES,
    );
    expect(result.artifacts.map((item) => item.kind)).toEqual(
      RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS,
    );
    expect(result.executionPlan.executionOrder).toEqual([
      "atomic-single-use-claim",
      "authenticated-t1-readback",
      "controller-deployment",
      "authenticated-controller-post-readback",
      "authenticated-edge-pre-readback",
      "edge-deployment",
      "authenticated-edge-post-readback",
    ]);
    expect(result.executionPlan.controller.targetPercentage).toBe(100);
    expect(result.executionPlan.edge.targetPercentage).toBe(100);
    expect(result.executionPlan.executableCommand).toBeNull();
    expect(result.credentialScope.credentialsDistinct).toBe(true);
    expect(
      new Set([
        result.credentialScope.replacementReadCredentialIdSha256,
        result.credentialScope.replacementClaimCredentialIdSha256,
        result.credentialScope.replacementDeployCredentialIdSha256,
      ]).size,
    ).toBe(3);
    expect(result.claimAuthority.migrationHead).toBe(
      "0059_relay_container_ring_transition_claims.sql",
    );
    expect(result.claimAuthority.remoteClaimPerformed).toBe(false);
    for (const name of [
      "credentialsReadByVerifier",
      "networkRequestsPerformedByVerifier",
      "filesWrittenByVerifier",
      "shellCommandsExecutedByVerifier",
      "customerTrafficAuthorized",
      "paidProviderCallsAuthorized",
      "productionCutoverAuthorized",
      "versionUploadAuthorized",
      "resourceMutationAuthorized",
      "secretMutationAuthorized",
      "cleanupMutationAuthorized",
      "deploymentDeletionAuthorized",
      "generationRollbackAuthorized",
      "goVpsShutdownAuthorized",
    ]) {
      expect(result[name]).toBe(false);
    }
  });

  test("has no transition-result or verifier injection path", async () => {
    const source = await readFile(
      path.resolve(
        import.meta.dir,
        "../tools/relay_container_ring_transition_authorization_contract.mjs",
      ),
      "utf8",
    );
    expect(source).not.toContain("transitionResult");
    expect(source).not.toContain("transitionVerifier");
    expect(source).not.toContain("authorizationVerifier");
    expect(source).toContain("verifyRingTransitionBundle({");
  });

  test("rejects transition binding and deployment intent drift", async () => {
    const cases = [
      (subject) => {
        subject.transitionBinding.planDigestSha256 = "f".repeat(64);
      },
      (subject) => {
        subject.deploymentIntent.controller.expectedDeploymentSetSha256 =
          "f".repeat(64);
      },
      (subject) => {
        subject.deploymentIntent.controller.targetVersionId =
          "controller-version-003";
      },
      (subject) => {
        subject.deploymentIntent.edge.serviceName = "other-staging-edge";
      },
      (subject) => {
        subject.deploymentIntent.nativeAtomicCasClaimed = true;
      },
      (subject) => {
        subject.deploymentIntent.maxExecutions = 2;
      },
    ];
    for (const mutateSubject of cases) {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        mutateSubject,
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow();
    }
  });

  test("rejects deployment, credential, operator, claim, and rollback evidence drift", async () => {
    const cases = [
      ["deployment-set-readback", (facts) => {
        facts.stableBeforeAfter = false;
      }],
      ["deployment-set-readback", (facts) => {
        facts.controller.activeVersions[0].percentage = 50;
      }],
      ["deployment-set-readback", (facts) => {
        facts.observedAfterAt = facts.observedBeforeAt;
      }],
      ["deployment-set-readback", (facts) => {
        facts.observedBeforeAt = new Date(
          fixedNow.getTime() - 500 * 1000,
        ).toISOString();
        facts.observedAfterAt = new Date(
          fixedNow.getTime() - 400 * 1000,
        ).toISOString();
      }],
      ["deployment-set-readback", (facts) => {
        facts.readCredentialIdSha256 = "9".repeat(64);
      }],
      ["credential-scope-readback", (facts) => {
        facts.exposedCredentialRevoked = false;
      }],
      ["credential-scope-readback", (facts) => {
        facts.replacementDeployCredentialIdSha256 =
          facts.replacementReadCredentialIdSha256;
      }],
      ["credential-scope-readback", (facts) => {
        facts.replacementClaimCredentialIdSha256 =
          facts.replacementReadCredentialIdSha256;
      }],
      ["operator-ceremony", (facts) => {
        facts.livePresence = false;
      }],
      ["operator-ceremony", (facts) => {
        facts.breakGlass = true;
      }],
      ["single-use-claim-readiness", (facts) => {
        facts.state = "claimed";
      }],
      ["single-use-claim-readiness", (facts) => {
        facts.remoteClaimPerformed = true;
      }],
      ["rollback-readiness", (facts) => {
        facts.goVpsTrafficAuthority = false;
      }],
      ["rollback-readiness", (facts) => {
        facts.controllerGenerationRollbackAuthorized = true;
      }],
    ];
    for (const [targetKind, mutateFacts] of cases) {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        mutateArtifact(kind, artifact) {
          if (kind === targetKind) mutateFacts(artifact.facts);
        },
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow();
    }
  });

  test("rejects stale, overlong, post-admission, and insufficient-lead authorizations", async () => {
    const cases = [
      (subject) => {
        subject.generatedAt = new Date(
          fixedNow.getTime() - 20 * 60 * 1000,
        ).toISOString();
      },
      (subject) => {
        subject.expiresAt = new Date(
          fixedNow.getTime() + 11 * 60 * 1000,
        ).toISOString();
      },
      (subject) => {
        subject.expiresAt = new Date(
          fixedNow.getTime() + 30 * 1000,
        ).toISOString();
      },
    ];
    for (const mutateSubject of cases) {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        mutateSubject,
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow();
    }
  });

  test("requires an external distinct policy and four distinct approval keys", async () => {
    {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        trustPolicyInsideBundle: true,
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow(/external/);
    }
    {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        reuseApprovalKeyMaterial: true,
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow(/distinct/);
    }
    {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        reuseTransitionApprovalKeyMaterial: true,
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow(/disjoint/);
    }
    {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle, {
        mutateApprovals(approvals) {
          [approvals[0], approvals[1]] = [approvals[1], approvals[0]];
        },
      });
      await expect(verifyAuthorization(bundle)).rejects.toThrow(/role order/);
    }
    {
      const transitionBundle = await createBundle();
      const bundle = await createAuthorizationBundle(transitionBundle);
      bundle.authorizationTrustPolicyPath =
        transitionBundle.trustPolicyPath;
      await expect(verifyAuthorization(bundle)).rejects.toThrow(/distinct/);
    }
  });

  test("verifies a real authorization CLI packet in a minimal environment", async () => {
    const liveNow = new Date();
    const transitionBundle = await createBundle({ liveNow });
    const bundle = await createAuthorizationBundle(transitionBundle, {
      liveNow,
    });
    const result = runAuthorizationCli(
      [
        "--transition-manifest",
        transitionBundle.manifestPath,
        "--transition-trust-policy",
        transitionBundle.trustPolicyPath,
        "--authorization-manifest",
        bundle.authorizationManifestPath,
        "--authorization-trust-policy",
        bundle.authorizationTrustPolicyPath,
        "--json",
      ],
      minimalChildEnv({
        CLOUDFLARE_API_TOKEN: "poison-must-not-be-read",
        CINATOKEN_RING_TRANSITION_REPLACEMENT_TOKEN:
          "poison-must-not-be-read",
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe(RING_TRANSITION_AUTHORIZATION_RESULT);
    expect(output.offlineSignedAuthorizationVerified).toBe(true);
    expect(output.trustedPolicyAnchorVerified).toBe(false);
    expect(output.remoteMutationAuthorized).toBe(false);
    expect(output.credentialsReadByVerifier).toBe(false);
    expect(output.networkRequestsPerformedByVerifier).toBe(false);
  });

  test("authorization CLI describe is deterministic and rejects ambiguous arguments", () => {
    const first = runAuthorizationCli(
      ["--describe", "--json"],
      minimalChildEnv(),
    );
    const second = runAuthorizationCli(
      ["--describe", "--json"],
      minimalChildEnv(),
    );
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    const described = JSON.parse(first.stdout);
    expect(described.constraints.atomicSingleUseRemoteClaimRequired).toBe(true);
    expect(described.constraints.applicationLevelOptimisticCasOnly).toBe(true);
    expect(described.constraints.cloudflareNativeAtomicCasClaimed).toBe(false);
    expect(described.constraints.trustedPolicyAnchorVerified).toBe(false);
    expect(described.constraints.runnerTrustedPolicyAnchorRequired).toBe(true);
    expect(described.constraints.authorizesRemoteMutation).toBe(false);
    expect(described.constraints.mutationPerformedByVerifier).toBe(false);

    for (const args of [
      ["--unknown"],
      ["--describe", "--authorization-manifest", "a"],
      ["--json", "--json", "--describe"],
      ["--transition-manifest", "a"],
    ]) {
      const result = runAuthorizationCli(args, minimalChildEnv());
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[input]");
    }
  });
});

describe("Relay Container transition deployment-set readback collector", () => {
  test("normalizes the locked Cloudflare deployment response shape", () => {
    const payload = deploymentEnvelope(
      "deployment-controller-001",
      "controller-version-001",
    );
    const normalized = normalizeDeploymentApiResponse(
      payload,
      "cinatoken-container-controller-staging",
    );
    expect(normalized.activeVersions).toEqual([
      { versionId: "controller-version-001", percentage: 100 },
    ]);
    expect(normalized.deploymentSetSha256).toBe(
      deploymentSetDigestSha256({
        serviceName: "cinatoken-container-controller-staging",
        deploymentId: "deployment-controller-001",
        strategy: "percentage",
        versions: [
          { versionId: "controller-version-001", percentage: 100 },
        ],
      }),
    );
  });

  test("collects two stable Controller and Edge snapshots without mutation or retry", async () => {
    const fixture = deploymentCollectorFixture();
    const transitionBundle = await createBundle({
      mutateArtifact(kind, artifact) {
        if (kind !== "previous-ring-readback") return;
        artifact.facts.controllerDeploymentSetSha256 =
          fixture.controllerDigest;
        artifact.facts.edgeDeploymentSetSha256 = fixture.edgeDigest;
      },
    });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return fixture.responseFor(url);
    };
    const snapshotTimes = [
      fixedNow,
      new Date(fixedNow.getTime() + 5 * 1000),
    ];
    const result = await collectRingTransitionDeploymentSetReadback({
      transitionManifestPath: transitionBundle.manifestPath,
      transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
      authorizationIdSha256: "1".repeat(64),
      executionNonceSha256: "2".repeat(64),
      readCredentialIdSha256: fixture.readCredentialIdSha256,
      accountId: "a".repeat(32),
      apiToken: "replacement-read-token-value",
      observationSeconds: 5,
      now: fixedNow,
      fetchImpl,
      sleepImpl: async () => {},
      clockImpl: () => snapshotTimes.shift(),
    });

    expect(result.kind).toBe("deployment-set-readback");
    expect(result.status).toBe("pass");
    expect(result.facts.stableBeforeAfter).toBe(true);
    expect(result.facts.mutationObserved).toBe(false);
    expect(result.facts.readCredentialIdSha256).toBe(
      fixture.readCredentialIdSha256,
    );
    expect(result.facts.observedBeforeAt).toBe(fixedNow.toISOString());
    expect(result.facts.observedAfterAt).toBe(
      new Date(fixedNow.getTime() + 5 * 1000).toISOString(),
    );
    expect(result.facts.controller.deploymentSetSha256).toBe(
      fixture.controllerDigest,
    );
    expect(result.facts.edge.deploymentSetSha256).toBe(fixture.edgeDigest);
    expect(calls).toHaveLength(9);
    expect(
      calls[0].url.endsWith(
        "/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/tokens/verify",
      ),
    ).toBe(true);
    expect(calls.every((call) => call.options.method === "GET")).toBe(true);
    expect(calls.every((call) => call.options.redirect === "error")).toBe(true);
    expect(
      calls.every(
        (call) =>
          call.options.headers.Authorization ===
          "Bearer replacement-read-token-value",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("replacement-read-token-value");
  });

  test("fails closed on version-detail drift, token mismatch, and bounded HTTP failures", async () => {
    {
      const fixture = deploymentCollectorFixture();
      const transitionBundle = await createBundle({
        mutateArtifact(kind, artifact) {
          if (kind !== "previous-ring-readback") return;
          artifact.facts.controllerDeploymentSetSha256 =
            fixture.controllerDigest;
          artifact.facts.edgeDeploymentSetSha256 = fixture.edgeDigest;
        },
      });
      let edgeVersionReads = 0;
      const snapshotTimes = [
        fixedNow,
        new Date(fixedNow.getTime() + 5 * 1000),
      ];
      await expect(
        collectRingTransitionDeploymentSetReadback({
          transitionManifestPath: transitionBundle.manifestPath,
          transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
          authorizationIdSha256: "1".repeat(64),
          executionNonceSha256: "2".repeat(64),
          readCredentialIdSha256: fixture.readCredentialIdSha256,
          accountId: "a".repeat(32),
          apiToken: "replacement-read-token-value",
          observationSeconds: 5,
          now: fixedNow,
          fetchImpl: async (url) => {
            if (
              url.includes("cinatoken-rust-api-staging/versions/")
            ) {
              edgeVersionReads += 1;
              return jsonResponse({
                success: true,
                result: {
                  id: "edge-version-001",
                  bindings: [{ name: `EDGE_${edgeVersionReads}` }],
                },
              });
            }
            return fixture.responseFor(url);
          },
          sleepImpl: async () => {},
          clockImpl: () => snapshotTimes.shift(),
        }),
      ).rejects.toThrow(/drifted/);
    }
    {
      const fixture = deploymentCollectorFixture();
      const transitionBundle = await createBundle({
        mutateArtifact(kind, artifact) {
          if (kind !== "previous-ring-readback") return;
          artifact.facts.controllerDeploymentSetSha256 =
            fixture.controllerDigest;
          artifact.facts.edgeDeploymentSetSha256 = fixture.edgeDigest;
        },
      });
      let calls = 0;
      await expect(
        collectRingTransitionDeploymentSetReadback({
          transitionManifestPath: transitionBundle.manifestPath,
          transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
          authorizationIdSha256: "1".repeat(64),
          executionNonceSha256: "2".repeat(64),
          readCredentialIdSha256: fixture.readCredentialIdSha256,
          accountId: "a".repeat(32),
          apiToken: "replacement-read-token-value",
          observationSeconds: 5,
          now: fixedNow,
          fetchImpl: async () => {
            calls += 1;
            return jsonResponse(
              { success: false, errors: [{ code: 1000 }] },
              503,
            );
          },
          sleepImpl: async () => {},
        }),
      ).rejects.toThrow(/HTTP 503/);
      expect(calls).toBe(1);
    }
    {
      const fixture = deploymentCollectorFixture();
      const transitionBundle = await createBundle();
      let calls = 0;
      await expect(
        collectRingTransitionDeploymentSetReadback({
          transitionManifestPath: transitionBundle.manifestPath,
          transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
          authorizationIdSha256: "1".repeat(64),
          executionNonceSha256: "2".repeat(64),
          readCredentialIdSha256: "9".repeat(64),
          accountId: "a".repeat(32),
          apiToken: "replacement-read-token-value",
          observationSeconds: 5,
          now: fixedNow,
          fetchImpl: async (url) => {
            calls += 1;
            return fixture.responseFor(url);
          },
          sleepImpl: async () => {},
        }),
      ).rejects.toThrow(/token identity mismatch/);
      expect(calls).toBe(1);
    }
    {
      const fixture = deploymentCollectorFixture();
      const transitionBundle = await createBundle();
      let calls = 0;
      await expect(
        collectRingTransitionDeploymentSetReadback({
          transitionManifestPath: transitionBundle.manifestPath,
          transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
          authorizationIdSha256: "1".repeat(64),
          executionNonceSha256: "2".repeat(64),
          readCredentialIdSha256: fixture.readCredentialIdSha256,
          accountId: "a".repeat(32),
          apiToken: "replacement-read-token-value",
          observationSeconds: 5,
          now: fixedNow,
          fetchImpl: async () => {
            calls += 1;
            return new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
              status: 200,
            });
          },
          sleepImpl: async () => {},
        }),
      ).rejects.toThrow(/byte bound/);
      expect(calls).toBe(1);
    }
    {
      const fixture = deploymentCollectorFixture();
      const transitionBundle = await createBundle({
        mutateArtifact(kind, artifact) {
          if (kind !== "previous-ring-readback") return;
          artifact.facts.controllerDeploymentSetSha256 =
            fixture.controllerDigest;
          artifact.facts.edgeDeploymentSetSha256 = fixture.edgeDigest;
        },
      });
      await expect(
        collectRingTransitionDeploymentSetReadback({
          transitionManifestPath: transitionBundle.manifestPath,
          transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
          authorizationIdSha256: "1".repeat(64),
          executionNonceSha256: "2".repeat(64),
          readCredentialIdSha256: fixture.readCredentialIdSha256,
          accountId: "a".repeat(32),
          apiToken: "replacement-read-token-value",
          observationSeconds: 5,
          now: fixedNow,
          fetchImpl: async (url) => fixture.responseFor(url),
          sleepImpl: async () => {},
          clockImpl: () => fixedNow,
        }),
      ).rejects.toThrow(/too short/);
    }
  });

  test("collector CLI dry-run reads no credential and rejects token arguments", async () => {
    const transitionBundle = await createBundle({ liveNow: new Date() });
    const args = [
      "--transition-manifest",
      transitionBundle.manifestPath,
      "--transition-trust-policy",
      transitionBundle.trustPolicyPath,
      "--authorization-id-sha256",
      "1".repeat(64),
      "--execution-nonce-sha256",
      "2".repeat(64),
      "--dry-run",
      "--json",
    ];
    const result = runDeploymentCollectorCli(
      args,
      minimalChildEnv({
        CLOUDFLARE_API_TOKEN: "poison-must-not-be-read",
        CINATOKEN_RING_TRANSITION_READ_TOKEN: "poison-must-not-be-read",
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.mode).toBe("dry-run");
    expect(output.credentialsRead).toBe(false);
    expect(output.networkRequestsPerformed).toBe(false);
    expect(output.deploymentMutationPerformed).toBe(false);
    expect(output.requestsPlanned).toBe(9);

    for (const invalidArgs of [
      [...args, "--api-token", "forbidden"],
      args.filter((value) => value !== "--dry-run"),
      [...args, "--confirm-no-mutation"],
    ]) {
      const invalid = runDeploymentCollectorCli(
        invalidArgs,
        minimalChildEnv(),
      );
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stdout).toBe("");
    }

    const liveMissingEnvironment = runDeploymentCollectorCli(
      [
        ...args.filter((value) => value !== "--dry-run"),
        "--confirm-staging-readback",
        "--confirm-replacement-read-token",
        "--confirm-exposed-credential-revoked",
        "--confirm-no-mutation",
      ],
      minimalChildEnv(),
    );
    expect(liveMissingEnvironment.exitCode).not.toBe(0);
    expect(liveMissingEnvironment.stdout).toBe("");
    expect(liveMissingEnvironment.stderr).toContain(
      "CINATOKEN_EXPOSED_CREDENTIAL_REVOCATION_EVIDENCE_SHA256",
    );
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
  return {
    root,
    manifestPath,
    trustPolicyPath,
    artifactPaths,
    approvalKeyPairs: keyPairs,
  };
}

async function verifyAuthorization(bundle) {
  return verifyRingTransitionMutationAuthorization({
    transitionManifestPath: bundle.transitionManifestPath,
    transitionTrustPolicyPath: bundle.transitionTrustPolicyPath,
    authorizationManifestPath: bundle.authorizationManifestPath,
    authorizationTrustPolicyPath: bundle.authorizationTrustPolicyPath,
    now: fixedNow,
  });
}

async function createAuthorizationBundle(transitionBundle, options = {}) {
  const now = options.liveNow ?? fixedNow;
  const timeline = authorizationTimelineFor(now);
  const transition = await verifyRingTransitionBundle({
    manifestPath: transitionBundle.manifestPath,
    trustPolicyPath: transitionBundle.trustPolicyPath,
    now,
  });
  const root = await mkdtemp(
    path.join(tmpdir(), "cinatoken-ring-transition-authorization-"),
  );
  const trustRoot = options.trustPolicyInsideBundle
    ? root
    : await mkdtemp(
        path.join(
          tmpdir(),
          "cinatoken-ring-transition-authorization-trust-",
        ),
      );
  temporaryRoots.push(root);
  if (trustRoot !== root) temporaryRoots.push(trustRoot);
  const evidenceRoot = path.join(root, "evidence");
  await mkdir(evidenceRoot);

  const sharedPair = options.reuseApprovalKeyMaterial
    ? generateKeyPairSync("ed25519")
    : null;
  const keyPairs = new Map();
  const keys = RING_TRANSITION_AUTHORIZATION_ROLES.map((role) => {
    const transitionPair =
      options.reuseTransitionApprovalKeyMaterial && role === "security"
        ? transitionBundle.approvalKeyPairs.get("security-transition-v1")
        : null;
    const pair = sharedPair ?? transitionPair ?? generateKeyPairSync("ed25519");
    const keyId = `${role}-transition-authorization-v1`;
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
    contract: RING_TRANSITION_AUTHORIZATION_TRUST_POLICY_CONTRACT,
    policyId: "staging-ring-transition-authorization-v1",
    environment: "staging",
    validFrom: timeline.policyValidFrom,
    validUntil: timeline.policyValidUntil,
    maxClockSkewSeconds: 60,
    keys,
  };
  options.mutatePolicy?.(trustPolicy);

  const authorizationIdSha256 = "1".repeat(64);
  const executionNonceSha256 = "2".repeat(64);
  const deploymentIntent = {
    phase: "open-adjacent-ring-transition",
    controllerFirst: true,
    edgeRequiresControllerReadback: true,
    optimisticConcurrencyMode: "read-verify-write-read",
    nativeAtomicCasClaimed: false,
    maxExecutions: 1,
    controller: {
      serviceName: transition.serviceIdentities.controllerWorker,
      expectedVersionId:
        transition.plan.controllerFirst.expectedPreviousVersionId,
      expectedDeploymentSetSha256:
        transition.plan.controllerFirst.previousDeploymentSetSha256,
      targetVersionId: transition.plan.controllerFirst.expectedVersionId,
      targetPercentage: 100,
      overlaySha256: sha256Hex(
        Buffer.from(
          canonicalJson(transition.plan.controllerFirst.vars),
          "utf8",
        ),
      ),
    },
    edge: {
      serviceName: transition.serviceIdentities.edgeWorker,
      expectedVersionId: transition.plan.edgeSecond.expectedPreviousVersionId,
      expectedDeploymentSetSha256:
        transition.plan.edgeSecond.previousDeploymentSetSha256,
      targetVersionId: transition.plan.edgeSecond.expectedVersionId,
      targetPercentage: 100,
      overlaySha256: sha256Hex(
        Buffer.from(canonicalJson(transition.plan.edgeSecond.vars), "utf8"),
      ),
    },
  };
  const artifactPaths = new Map();
  const artifactRecords = [];
  for (const [index, kind] of RING_TRANSITION_AUTHORIZATION_EVIDENCE_KINDS.entries()) {
    const artifact = {
      schemaVersion: 1,
      contract: RING_TRANSITION_AUTHORIZATION_EVIDENCE_CONTRACT,
      kind,
      environment: "staging",
      authorizationIdSha256,
      transitionSubjectDigestSha256: transition.subjectDigestSha256,
      capturedAt: new Date(
        new Date(timeline.artifactCapturedBase).getTime() + index * 1000,
      ).toISOString(),
      expiresAt: timeline.evidenceExpiresAt,
      status: "pass",
      facts: authorizationArtifactFactsFixture(
        kind,
        transition,
        deploymentIntent,
        {
          ...timeline,
          authorizationIdSha256,
          executionNonceSha256,
        },
      ),
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
    decision: RING_TRANSITION_AUTHORIZATION_DECISION,
    generatedAt: timeline.generatedAt,
    expiresAt: timeline.expiresAt,
    authorizationIdSha256,
    executionNonceSha256,
    transitionBinding: {
      manifestDigestSha256: transition.manifestDigestSha256,
      subjectDigestSha256: transition.subjectDigestSha256,
      policyDigestSha256: transition.policyDigestSha256,
      planDigestSha256: transition.planDigestSha256,
      candidateDigestSha256: transition.candidateDigestSha256,
      reviewDecision: transition.decision,
    },
    deploymentIntent,
    artifacts: artifactRecords,
    safetyBoundary: {
      isolatedStagingOnly: true,
      remoteMutationScope: "worker-deployments-only",
      workerDeploymentMutationAuthorized: true,
      customerTrafficAuthorized: false,
      paidProviderCallsAuthorized: false,
      productionCutoverAuthorized: false,
      versionUploadAuthorized: false,
      resourceMutationAuthorized: false,
      secretMutationAuthorized: false,
      cleanupMutationAuthorized: false,
      deploymentDeletionAuthorized: false,
      generationRollbackAuthorized: false,
      goVpsShutdownAuthorized: false,
    },
  };
  options.mutateSubject?.(subject);
  const subjectDigestSha256 = sha256Hex(
    Buffer.from(canonicalJson(subject), "utf8"),
  );
  const approvals = RING_TRANSITION_AUTHORIZATION_ROLES.map((role) => {
    const keyId = `${role}-transition-authorization-v1`;
    const approval = {
      role,
      keyId,
      signedAt: timeline.signedAt,
      expiresAt: timeline.expiresAt,
      subjectDigestSha256,
      signatureBase64url: "",
    };
    approval.signatureBase64url = signMessage(
      null,
      ringTransitionAuthorizationApprovalMessage({
        policyId: subject.policyId,
        environment: subject.environment,
        role,
        keyId,
        subjectDigestSha256,
        signedAt: approval.signedAt,
        expiresAt: approval.expiresAt,
      }),
      keyPairs.get(keyId).privateKey,
    ).toString("base64url");
    return approval;
  });
  options.mutateApprovals?.(approvals);
  const manifest = {
    schemaVersion: 1,
    contract: RING_TRANSITION_AUTHORIZATION_MANIFEST_CONTRACT,
    subject,
    subjectDigestSha256,
    approvals,
  };
  options.mutateManifest?.(manifest);

  const authorizationManifestPath = path.join(root, "authorization.json");
  const authorizationTrustPolicyPath = path.join(
    trustRoot,
    "authorization-trust-policy.json",
  );
  await writeCanonical(authorizationManifestPath, manifest);
  await writeCanonical(authorizationTrustPolicyPath, trustPolicy);
  await options.afterWrite?.({
    root,
    authorizationManifestPath,
    authorizationTrustPolicyPath,
    artifactPaths,
  });
  return {
    root,
    transitionManifestPath: transitionBundle.manifestPath,
    transitionTrustPolicyPath: transitionBundle.trustPolicyPath,
    authorizationManifestPath,
    authorizationTrustPolicyPath,
    artifactPaths,
  };
}

function authorizationArtifactFactsFixture(
  kind,
  transition,
  deploymentIntent,
  timeline,
) {
  switch (kind) {
    case "deployment-set-readback":
      return {
        accountIdSha256: "3".repeat(64),
        transport: "cloudflare-api",
        paginationComplete: true,
        observedBeforeAt: timeline.observedBeforeAt,
        observedAfterAt: timeline.observedAfterAt,
        stableBeforeAfter: true,
        mutationObserved: false,
        executionNonceSha256: timeline.executionNonceSha256,
        readCredentialIdSha256: "7".repeat(64),
        transitionPlanDigestSha256: transition.planDigestSha256,
        controller: {
          serviceName: deploymentIntent.controller.serviceName,
          deploymentSetSha256:
            deploymentIntent.controller.expectedDeploymentSetSha256,
          activeVersions: [
            {
              versionId: deploymentIntent.controller.expectedVersionId,
              percentage: 100,
            },
          ],
          versionDetailSha256: "4".repeat(64),
        },
        edge: {
          serviceName: deploymentIntent.edge.serviceName,
          deploymentSetSha256:
            deploymentIntent.edge.expectedDeploymentSetSha256,
          activeVersions: [
            {
              versionId: deploymentIntent.edge.expectedVersionId,
              percentage: 100,
            },
          ],
          versionDetailSha256: "5".repeat(64),
        },
      };
    case "credential-scope-readback":
      return {
        accountIdSha256: "3".repeat(64),
        exposedCredentialRevoked: true,
        revokedAt: timeline.revokedAt,
        revocationReadbackSha256: "6".repeat(64),
        replacementReadCredentialIdSha256: "7".repeat(64),
        replacementClaimCredentialIdSha256: "f".repeat(64),
        replacementDeployCredentialIdSha256: "8".repeat(64),
        credentialsDistinct: true,
        readCredentialLeastPrivilege: true,
        claimCredentialLeastPrivilege: true,
        deployCredentialLeastPrivilege: true,
        scopeAuditSha256: "9".repeat(64),
        secretValueIncluded: false,
      };
    case "operator-ceremony":
      return {
        authorizationIdSha256: timeline.authorizationIdSha256,
        executionNonceSha256: timeline.executionNonceSha256,
        operatorCount: 2,
        operatorsDistinct: true,
        livePresence: true,
        breakGlass: false,
        sessionDigestSha256: "a".repeat(64),
        recordingDigestSha256: "b".repeat(64),
        abortOwner: "operations-primary",
      };
    case "single-use-claim-readiness":
      return {
        authorizationIdSha256: timeline.authorizationIdSha256,
        executionNonceSha256: timeline.executionNonceSha256,
        authority: "d1-unique-claim-v1",
        ledgerIdentitySha256: "c".repeat(64),
        claimAuthorityOriginSha256: "1".repeat(64),
        migrationHead:
          "0059_relay_container_ring_transition_claims.sql",
        claimTable: "relay_container_ring_transition_claims",
        stepTable: "relay_container_ring_transition_steps",
        claimCredentialIdSha256: "f".repeat(64),
        state: "unclaimed",
        atomicUniqueInsertRequired: true,
        ttlBound: true,
        remoteClaimPerformed: false,
      };
    case "rollback-readiness":
      return {
        goVpsTrafficAuthority: true,
        goVpsSchedulerAuthority: true,
        controllerDrainRetained: true,
        edgeMayRemainPreviousAfterControllerSuccess: true,
        controllerGenerationRollbackAuthorized: false,
        disableRustAdmissionPlanSha256: "d".repeat(64),
        forwardRepairPlanSha256: "e".repeat(64),
        transitionPlanDigestSha256: transition.planDigestSha256,
      };
    default:
      throw new Error(`unknown authorization artifact kind ${kind}`);
  }
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
    migrationHead: "0059_relay_container_ring_transition_claims.sql",
    migrationCount: 59,
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

function deploymentCollectorFixture() {
  const controllerService = "cinatoken-container-controller-staging";
  const edgeService = "cinatoken-rust-api-staging";
  const controllerDeploymentId = "deployment-controller-001";
  const edgeDeploymentId = "deployment-edge-001";
  const controllerVersionId = "controller-version-001";
  const edgeVersionId = "edge-version-001";
  const readTokenId = "replacement-read-token-id-001";
  return {
    readCredentialIdSha256: sha256Hex(Buffer.from(readTokenId, "utf8")),
    controllerDigest: deploymentSetDigestSha256({
      serviceName: controllerService,
      deploymentId: controllerDeploymentId,
      strategy: "percentage",
      versions: [{ versionId: controllerVersionId, percentage: 100 }],
    }),
    edgeDigest: deploymentSetDigestSha256({
      serviceName: edgeService,
      deploymentId: edgeDeploymentId,
      strategy: "percentage",
      versions: [{ versionId: edgeVersionId, percentage: 100 }],
    }),
    responseFor(url) {
      if (url.endsWith("/tokens/verify")) {
        return jsonResponse({
          success: true,
          result: { id: readTokenId, status: "active" },
        });
      }
      if (url.includes(`${controllerService}/deployments`)) {
        return jsonResponse(
          deploymentEnvelope(controllerDeploymentId, controllerVersionId),
        );
      }
      if (url.includes(`${edgeService}/deployments`)) {
        return jsonResponse(deploymentEnvelope(edgeDeploymentId, edgeVersionId));
      }
      if (url.includes(`${controllerService}/versions/${controllerVersionId}`)) {
        return jsonResponse({
          success: true,
          result: {
            id: controllerVersionId,
            bindings: [{ name: "RELAY_SHARDS", type: "durable_object_namespace" }],
            observability: { head_sampling_rate: 0.1 },
          },
        });
      }
      if (url.includes(`${edgeService}/versions/${edgeVersionId}`)) {
        return jsonResponse({
          success: true,
          result: {
            id: edgeVersionId,
            bindings: [{ name: "CONTAINER_CONTROLLER", type: "service" }],
            observability: { head_sampling_rate: 1 },
          },
        });
      }
      throw new Error(`unexpected collector URL ${url}`);
    },
  };
}

function deploymentEnvelope(deploymentId, versionId) {
  return {
    success: true,
    result: {
      deployments: [
        {
          id: deploymentId,
          strategy: "percentage",
          versions: [{ version_id: versionId, percentage: 100 }],
        },
      ],
    },
  };
}

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
  });
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

function runAuthorizationCli(args, env) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/verify_relay_container_ring_transition_authorization.mjs",
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

function runDeploymentCollectorCli(args, env) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/collect_relay_container_ring_transition_deployment_sets.mjs",
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

function authorizationTimelineFor(now) {
  const baseMs = Math.floor(now.getTime() / 1000) * 1000;
  const at = (offsetSeconds) =>
    new Date(baseMs + offsetSeconds * 1000).toISOString();
  return {
    policyValidFrom: at(-3600),
    policyValidUntil: at(24 * 60 * 60),
    revokedAt: at(-30 * 60),
    observedBeforeAt: at(-150),
    observedAfterAt: at(-120),
    artifactCapturedBase: at(-110),
    generatedAt: at(-60),
    signedAt: at(-30),
    expiresAt: at(5 * 60),
    evidenceExpiresAt: at(6 * 60),
  };
}
