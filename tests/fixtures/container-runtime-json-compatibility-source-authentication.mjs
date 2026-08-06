import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalJson,
  sha256Canonical,
} from "../../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
  buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest,
  signJsonCompatibilityDeploymentTransition,
} from "../../tools/container_runtime_json_compatibility_deployment_transition.mjs";
import {
  buildExecutionAuthority,
} from "./container-runtime-json-compatibility-deployment-transition.mjs";
import {
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
  buildJsonCompatibilitySourceAccountBindingInventory,
  buildJsonCompatibilitySourceArtifactInventoryReadback,
  buildJsonCompatibilitySourceAuthenticationBundle,
  buildJsonCompatibilitySourceImmutableArchiveReceipt,
  buildJsonCompatibilitySourceSignatureEnvelope,
  buildJsonCompatibilitySourceSignatureSubject,
  buildJsonCompatibilitySourceVerifierIdentity,
  buildJsonCompatibilitySourceVerifierPolicy,
  buildJsonCompatibilityTransitionSourceManifest,
  sourceAuthenticationBundleKey,
  sourceSignatureSigningPayload,
} from "../../tools/container_runtime_json_compatibility_source_authentication.mjs";
import {
  buildJsonCompatibilityExternalWormArchiveEvidence,
  buildJsonCompatibilityExternalWormArchiveManifest,
  buildJsonCompatibilityExternalWormArchiveObjectDescriptor,
  buildJsonCompatibilityExternalWormArchiveObjectObservation,
  buildJsonCompatibilityExternalWormArchivePassRoot,
  buildJsonCompatibilityExternalWormArchivePolicy,
  buildJsonCompatibilityExternalWormAttestationEnvelope,
  buildJsonCompatibilityExternalWormReadbackObservationSubject,
  buildJsonCompatibilityExternalWormWriteObservationSubject,
  externalWormArchiveAttestationSigningPayload,
} from "../../tools/container_runtime_json_compatibility_external_worm_archive.mjs";
import {
  buildJsonCompatibilityExternalWormS3Closure,
  deriveJsonCompatibilityExternalWormS3ArchiveIdentities,
} from "../../tools/container_runtime_json_compatibility_external_worm_s3_closure.mjs";
import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
  JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
  deriveJsonCompatibilityExternalWormS3ReadbackRequestSetSha256,
} from "../../tools/container_runtime_json_compatibility_external_worm_s3_observation.mjs";
import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES,
  accountBindingInventoryInputFromEvidence,
  buildJsonCompatibilityAccountBindingAuthenticationIdentity,
  buildJsonCompatibilityAccountBindingCollectionArtifact,
  buildJsonCompatibilityAccountBindingCollectionProfile,
  buildJsonCompatibilityAccountBindingCollectorIdentity,
  buildJsonCompatibilityAccountBindingEvidence,
  buildJsonCompatibilityAccountBindingPageReceipt,
  buildJsonCompatibilityAccountBindingSnapshot,
} from "../../tools/container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  accountBindingCredentialSigningPayload,
  buildJsonCompatibilityAccountBindingCredentialProvenance,
  buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope,
  buildJsonCompatibilityAccountBindingCredentialReceiptSubject,
  buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope,
  buildJsonCompatibilityAccountBindingCredentialRevocationSubject,
  buildJsonCompatibilityAccountBindingCredentialTrustPolicy,
} from "../../tools/container_runtime_json_compatibility_account_binding_credentials.mjs";
import {
  createSyntheticJsonCompatibilitySourceManifest,
} from "../../tools/container_runtime_json_compatibility_source_manifest.mjs";
import {
  prepareJsonCompatibilityControllerConfig,
} from "../../tools/prepare_container_runtime_json_compatibility_controller_config.mjs";
import {
  TRANSITION_IDS,
  buildCampaignPlan,
  buildStatePlan,
  digest,
} from "./container-runtime-json-compatibility-deployment-transition.mjs";

export const SOURCE_SIGNATURE_KEY_ID =
  "json-compatibility-source-archive-2026-08";

export async function createSourceAuthenticationFixture({
  now = 1_786_000_000,
  transitionId = TRANSITION_IDS[0],
  operationSeed = "source-authentication-operation",
  invalidSourceSignature = false,
  invalidExternalWormPolicyAnchor = false,
  invalidExternalWormWriterSignature = false,
  invalidExternalWormReadbackSignature = false,
  driftExternalWormS3ProviderObservations = false,
  externalWormSignerReuseSource = null,
  sourceSignerTrustSlot = "current",
  sourceVerifierVersionId = "source-verifier-version-001",
  executionAuthorityOverrides = {},
  evidenceObservedAt = now - 120,
  archiveLockedAt = now - 90,
  archiveReadbackAt = now - 60,
  archiveRetainUntil = now + 366 * 24 * 60 * 60,
} = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cinatoken-source-authentication-fixture-"),
  );
  let transitionPrivateKey = null;
  let sourcePrivateKey = null;
  try {
    const configPath = path.join(directory, "controller-execution.jsonc");
    await prepareJsonCompatibilityControllerConfig({ outPath: configPath });
    const controllerConfig = JSON.parse(await readFile(configPath, "utf8"));
    const transitionKeys = generateKeyPairSync("ed25519");
    transitionPrivateKey = transitionKeys.privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    const transitionSpkiSha256 = createHash("sha256")
      .update(transitionKeys.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
    const sourceKeys = generateKeyPairSync("ed25519");
    sourcePrivateKey = sourceKeys.privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    const sourceSpki = sourceKeys.publicKey.export({
      format: "der",
      type: "spki",
    });
    const sourceSignerSpkiSha256 = createHash("sha256")
      .update(sourceSpki)
      .digest("hex");
    const statePlan = buildStatePlan(sha256Canonical(controllerConfig));
    const campaignPlan = buildCampaignPlan(
      controllerConfig,
      statePlan,
      transitionSpkiSha256,
    );
    const accountIdSha256 = digest("cloudflare-account-staging");
    const observedAt = evidenceObservedAt;
    const transition = statePlan.transitions.find(
      (value) => value.id === transitionId,
    );
    if (transition === undefined) throw new Error("transition fixture is absent");
    const profile = transition.fromState === "dark"
        || transition.toState === "execution"
      ? "release-v1"
      : "campaign-closure-v1";
    const transitionBinding = {
      id: transition.id,
      ordinal: transition.ordinal,
      fromState: transition.fromState,
      toState: transition.toState,
      transitionSha256: sha256Canonical(transition),
    };
    const transitionSourceManifest =
      buildJsonCompatibilityTransitionSourceManifest({
        campaignPlan,
        statePlan,
        accountIdSha256,
        sourceRevisionSha256: digest("source-revision"),
        sourceTreeSha256: digest("source-tree"),
        workerBundleSetSha256: digest("worker-bundle-set"),
        containerImageSetSha256: digest("container-image-set"),
        d1MigrationSetSha256: digest("d1-migration-set"),
        contractSetSha256: digest("contract-set"),
        createdAt: observedAt,
      });
    const phaseSourceManifest = profile === "campaign-closure-v1"
      ? createSyntheticJsonCompatibilitySourceManifest(campaignPlan)
      : null;
    const artifacts = sourceArtifactObservations(statePlan);
    const artifactInventoryReadback =
      buildJsonCompatibilitySourceArtifactInventoryReadback({
        campaignPlan,
        statePlan,
        accountIdSha256,
        artifacts,
        observedAt,
      });
    const accountBindingEvidence = buildAccountBindingEvidenceFixture({
      campaignPlan,
      statePlan,
      accountIdSha256,
      observedAt,
    });
    const accountBindingInventory =
      buildJsonCompatibilitySourceAccountBindingInventory({
        campaignPlan,
        statePlan,
        ...accountBindingInventoryInputFromEvidence(accountBindingEvidence),
      });
    const operationIdSha256 = digest(operationSeed);
    const externalWormArchive = await buildExternalWormArchiveEvidenceFixture({
      campaignPlan,
      statePlan,
      accountIdSha256,
      transitionSourceManifest,
      phaseSourceManifest,
      artifactInventoryReadback,
      accountBindingEvidence,
      accountBindingInventory,
      operationSeed,
      sourceKeys,
      externalWormSignerReuseSource,
      invalidWriterSignature: invalidExternalWormWriterSignature,
      invalidReadbackSignature: invalidExternalWormReadbackSignature,
      archiveLockedAt,
      archiveReadbackAt,
      archiveRetainUntil,
    });
    const externalWormArchiveEvidence = externalWormArchive.evidence;
    const externalWormS3Closure = driftExternalWormS3ProviderObservations
      ? driftExternalWormS3ProviderObservationMetadata(
        externalWormArchive.s3Closure,
      )
      : externalWormArchive.s3Closure;
    const collectionCaptureTerminal =
      externalWormArchive.collectionCaptureTerminal;
    const independentReadbackCaptureTerminal =
      externalWormArchive.independentReadbackCaptureTerminal;
    const externalWormArchivePolicySha256 =
      externalWormArchive.policy.archivePolicySha256;
    const sourceVerifierExternalWormArchivePolicySha256 =
      invalidExternalWormPolicyAnchor
        ? differentSha256(externalWormArchivePolicySha256)
        : externalWormArchivePolicySha256;
    const immutableSourceArchiveReceipt =
      buildJsonCompatibilitySourceImmutableArchiveReceipt({
        externalWormArchiveEvidence,
        externalWormS3Closure,
        collectionCaptureTerminal,
        independentReadbackCaptureTerminal,
      });
    let sourcePolicyCurrent = {
      keyId: SOURCE_SIGNATURE_KEY_ID,
      spkiSha256: sourceSignerSpkiSha256,
    };
    let sourcePolicyPrevious = null;
    if (sourceSignerTrustSlot === "previous") {
      const nextKeys = generateKeyPairSync("ed25519");
      const nextSpki = nextKeys.publicKey.export({ format: "der", type: "spki" });
      sourcePolicyCurrent = {
        keyId: "json-compatibility-source-archive-next-2026-08",
        spkiSha256: createHash("sha256").update(nextSpki).digest("hex"),
      };
      sourcePolicyPrevious = {
        keyId: SOURCE_SIGNATURE_KEY_ID,
        spkiSha256: sourceSignerSpkiSha256,
        acceptUntil: now + 60,
      };
    } else if (sourceSignerTrustSlot !== "current") {
      throw new Error("source signer trust slot is invalid");
    }
    const sourceVerifierPolicy = buildJsonCompatibilitySourceVerifierPolicy({
      serviceName: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
      profileVersion: 1,
      keyPrefix:
        "container-runtime/json-compatibility/source-authentication/v3/sha256",
      issuer: JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
      audience: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
      externalWormArchivePolicySha256:
        sourceVerifierExternalWormArchivePolicySha256,
      current: sourcePolicyCurrent,
      previous: sourcePolicyPrevious,
    });
    const sourceVerifierIdentity = buildJsonCompatibilitySourceVerifierIdentity({
      versionId: sourceVerifierVersionId,
      sourceVerifierPolicySha256:
        sourceVerifierPolicy.sourceVerifierPolicySha256,
    });
    const sourceEvidenceWithoutEnvelope = {
      schemaVersion: 2,
      contract:
        "cinatoken-container-runtime-json-compatibility-deployment-transition-source-evidence-v2",
      profile,
      accountIdSha256,
      transitionSourceManifestSha256:
        transitionSourceManifest.transitionSourceManifestSha256,
      phaseSourceManifestSha256:
        phaseSourceManifest?.sourceManifestSha256 ?? null,
      sourceSignatureEnvelopeSha256: digest("source-envelope-placeholder"),
      sourceVerifierPolicySha256:
        sourceVerifierPolicy.sourceVerifierPolicySha256,
      sourceVerifierIdentitySha256:
        sourceVerifierIdentity.sourceVerifierIdentitySha256,
      immutableSourceArchiveReceiptSha256:
        immutableSourceArchiveReceipt.immutableSourceArchiveReceiptSha256,
      artifactInventoryReadbackSha256:
        artifactInventoryReadback.artifactInventoryReadbackSha256,
      accountBindingInventorySha256:
        accountBindingInventory.accountBindingInventorySha256,
    };
    const requestWithoutEnvelope =
      buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
        operationIdSha256,
        operationDigestSha256: digest("operation-digest-placeholder"),
        authorizedTransitionSha256:
          digest("authorized-transition-placeholder"),
        campaignPlanDigestSha256: campaignPlan.planDigestSha256,
        statePlanDigestSha256: statePlan.planDigestSha256,
        transition: transitionBinding,
        sourceEvidence: sourceEvidenceWithoutEnvelope,
      });
    const sourceSignatureSubject = buildJsonCompatibilitySourceSignatureSubject({
      sourceAuthenticationRequest: requestWithoutEnvelope,
      accountBindingEvidenceSha256:
        accountBindingEvidence.accountBindingEvidenceSha256,
      immutableSourceArchiveReceiptSha256:
        immutableSourceArchiveReceipt.immutableSourceArchiveReceiptSha256,
      keyId: SOURCE_SIGNATURE_KEY_ID,
      issuedAt: now,
      notBefore: now,
      expiresAt: now + 24 * 60 * 60,
    });
    const signature = invalidSourceSignature
      ? Buffer.alloc(64, 0x07)
      : sign(
        null,
        sourceSignatureSigningPayload(sourceSignatureSubject),
        sourceKeys.privateKey,
      );
    const sourceSignatureEnvelope =
      buildJsonCompatibilitySourceSignatureEnvelope({
        subject: sourceSignatureSubject,
        signerSpkiBase64url: sourceSpki.toString("base64url"),
        signatureBase64url: signature.toString("base64url"),
      });
    const sourceSignatureEnvelopeSha256 =
      sha256Canonical(sourceSignatureEnvelope);
    const sourceEvidence = {
      ...sourceEvidenceWithoutEnvelope,
      sourceSignatureEnvelopeSha256,
    };
    const authorizedTransition = signJsonCompatibilityDeploymentTransition({
      campaignPlan,
      statePlan,
      transitionId,
      operationIdSha256,
      priorStateEvidence: {
        state: transition.fromState,
        enteredAt: now - transition.minimumHoldSeconds,
        evidenceSha256: digest(`source-prior-state:${transitionId}`),
      },
      sourceEvidence,
      artifactInventoryReadback,
      executionAuthority: buildExecutionAuthority(
        sourceEvidence.accountIdSha256,
        {
          ...executionAuthorityOverrides,
          "source-verifier": {
            ...(executionAuthorityOverrides["source-verifier"] ?? {}),
            versionId: sourceVerifierVersionId,
            identitySha256:
              sourceVerifierIdentity.sourceVerifierIdentitySha256,
          },
        },
      ),
      privateKeyBytes: transitionPrivateKey,
      now: new Date(now * 1000),
    });
    const sourceAuthenticationRequest =
      buildJsonCompatibilityDeploymentTransitionSourceAuthenticationRequest({
        operationIdSha256,
        operationDigestSha256: sha256Canonical({
          schemaVersion: 1,
          contract: JSON_COMPATIBILITY_DEPLOYMENT_TRANSITION_OPERATION_CONTRACT,
          operationIdSha256,
          authorizedRequestSha256: sha256Canonical(authorizedTransition),
          campaignPlanDigestSha256: campaignPlan.planDigestSha256,
          statePlanDigestSha256: statePlan.planDigestSha256,
          transitionId,
        }),
        authorizedTransitionSha256: sha256Canonical(authorizedTransition),
        campaignPlanDigestSha256: campaignPlan.planDigestSha256,
        statePlanDigestSha256: statePlan.planDigestSha256,
        transition: transitionBinding,
        sourceEvidence,
      });
    const bundle = buildJsonCompatibilitySourceAuthenticationBundle({
      sourceAuthenticationRequest,
      campaignPlan,
      statePlan,
      transitionSourceManifest,
      phaseSourceManifest,
      artifactInventoryReadback,
      accountBindingEvidence,
      accountBindingInventory,
      externalWormArchiveEvidence,
      externalWormS3Closure,
      collectionCaptureTerminal,
      independentReadbackCaptureTerminal,
      immutableSourceArchiveReceipt,
      sourceSignatureEnvelope,
    });
    return {
      now,
      campaignPlan,
      statePlan,
      authorizedTransition,
      sourceAuthenticationRequest,
      bundle,
      bundleBody: `${canonicalJson(bundle)}\n`,
      bundleKey: sourceAuthenticationBundleKey(
        sourceSignatureEnvelopeSha256,
      ),
      sourceSignatureEnvelopeSha256,
      sourceSignerSpkiSha256,
      sourceSignerSpkiBase64url: sourceSpki.toString("base64url"),
      sourceSignatureKeyId: SOURCE_SIGNATURE_KEY_ID,
      sourcePolicyCurrent,
      sourcePolicyPrevious,
      sourceVerifierVersionId,
      sourceVerifierIdentity,
      externalWormArchiveEvidence,
      externalWormS3Closure,
      collectionCaptureTerminal,
      independentReadbackCaptureTerminal,
      externalWormArchivePolicySha256,
      sourceVerifierExternalWormArchivePolicySha256,
      externalWormWriterSpkiSha256:
        externalWormArchive.writer.policy.spkiSha256,
      externalWormReadbackSpkiSha256:
        externalWormArchive.readback.policy.spkiSha256,
    };
  } finally {
    transitionPrivateKey?.fill(0);
    sourcePrivateKey?.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
}

async function buildExternalWormArchiveEvidenceFixture({
  campaignPlan,
  statePlan,
  accountIdSha256,
  transitionSourceManifest,
  phaseSourceManifest,
  artifactInventoryReadback,
  accountBindingEvidence,
  accountBindingInventory,
  operationSeed,
  sourceKeys,
  externalWormSignerReuseSource,
  invalidWriterSignature,
  invalidReadbackSignature,
  archiveLockedAt,
  archiveReadbackAt,
  archiveRetainUntil,
}) {
  if (
    externalWormSignerReuseSource !== null
    && externalWormSignerReuseSource !== "writer"
    && externalWormSignerReuseSource !== "independent-readback"
  ) throw new Error("external WORM signer reuse fixture mode is invalid");
  const writer = externalWormActor(
    "writer",
    externalWormSignerReuseSource === "writer" ? sourceKeys : null,
  );
  const readback = externalWormActor(
    "independent-readback",
    externalWormSignerReuseSource === "independent-readback"
      ? sourceKeys
      : null,
  );
  const collectionPass = externalWormPassFixture(
    accountBindingEvidence.collection,
  );
  const readbackPass = externalWormPassFixture(
    accountBindingEvidence.independentReadback,
  );
  const globalObjects = [
    externalWormGlobalObject(
      "campaign-plan",
      campaignPlan,
      campaignPlan.planDigestSha256,
    ),
    externalWormGlobalObject(
      "state-plan",
      statePlan,
      statePlan.planDigestSha256,
    ),
    externalWormGlobalObject(
      "collector-identity",
      accountBindingEvidence.collection.collectorIdentity,
      accountBindingEvidence.collectionProfile.collectorIdentitySha256,
    ),
    externalWormGlobalObject(
      "collection-profile",
      accountBindingEvidence.collectionProfile,
      accountBindingEvidence.collectionProfile.collectionProfileSha256,
    ),
    externalWormGlobalObject(
      "account-binding-evidence",
      accountBindingEvidence,
      accountBindingEvidence.accountBindingEvidenceSha256,
    ),
    externalWormGlobalObject(
      "account-binding-inventory",
      accountBindingInventory,
      accountBindingInventory.accountBindingInventorySha256,
    ),
    externalWormGlobalObject(
      "transition-source-manifest",
      transitionSourceManifest,
      transitionSourceManifest.transitionSourceManifestSha256,
    ),
    externalWormGlobalObject(
      "artifact-inventory-readback",
      artifactInventoryReadback,
      artifactInventoryReadback.artifactInventoryReadbackSha256,
    ),
  ];
  if (phaseSourceManifest !== null) {
    globalObjects.push(externalWormGlobalObject(
      "phase-source-manifest",
      phaseSourceManifest,
      phaseSourceManifest.sourceManifestSha256,
    ));
  }
  const objects = [
    ...collectionPass.objects,
    ...readbackPass.objects,
    ...globalObjects,
  ];
  const s3Target = {
    provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
    region: "ap-southeast-1",
    bucketNameSha256: digest("external-worm-s3-bucket:staging"),
    expectedBucketOwnerSha256:
      digest("external-worm-s3-owner:staging"),
    objectKeySha256s: objects.map((value) => value.objectKeySha256),
  };
  const s3Identity =
    await deriveJsonCompatibilityExternalWormS3ArchiveIdentities(s3Target);
  const policy = buildJsonCompatibilityExternalWormArchivePolicy({
    backendIdentitySha256: s3Identity.backendIdentitySha256,
    namespaceIdentitySha256: s3Identity.namespaceIdentitySha256,
    effectiveAt: Math.min(
      collectionPass.rootInput.observedAt,
      readbackPass.rootInput.observedAt,
    ) - 60,
    writer: writer.policy,
    readback: readback.policy,
  });
  const collection = buildJsonCompatibilityExternalWormArchivePassRoot({
    ...collectionPass.rootInput,
    objects,
  });
  const independentReadback =
    buildJsonCompatibilityExternalWormArchivePassRoot({
      ...readbackPass.rootInput,
      objects,
    });
  const manifest = buildJsonCompatibilityExternalWormArchiveManifest({
    archivePolicy: policy,
    archiveOperationIdSha256:
      digest(`${operationSeed}:external-worm-archive`),
    accountIdSha256,
    campaignPlanDigestSha256: campaignPlan.planDigestSha256,
    statePlanDigestSha256: statePlan.planDigestSha256,
    collectionProfileSha256:
      accountBindingEvidence.collectionProfile.collectionProfileSha256,
    collectorIdentitySha256:
      accountBindingEvidence.collectionProfile.collectorIdentitySha256,
    collection,
    independentReadback,
    accountBindingEvidenceSha256:
      accountBindingEvidence.accountBindingEvidenceSha256,
    accountBindingInventorySha256:
      accountBindingInventory.accountBindingInventorySha256,
    transitionSourceManifestSha256:
      transitionSourceManifest.transitionSourceManifestSha256,
    phaseSourceManifestSha256:
      phaseSourceManifest?.sourceManifestSha256 ?? null,
    artifactInventoryReadbackSha256:
      artifactInventoryReadback.artifactInventoryReadbackSha256,
    objects,
    createdAt: Math.max(
      collectionPass.rootInput.observedAt,
      readbackPass.rootInput.observedAt,
    ),
  });
  const writeCompletedAt = archiveLockedAt + 1;
  const s3Observations = await externalWormS3Observations({
    objects: manifest.objects,
    operationSeed,
    target: s3Target,
    writerCredentialIdSha256: writer.policy.credentialIdSha256,
    readerCredentialIdSha256: readback.policy.credentialIdSha256,
    writerObservedAt: writeCompletedAt,
    readbackObservedAt: archiveReadbackAt,
    retainUntil: archiveRetainUntil,
  });
  const writeSubject =
    buildJsonCompatibilityExternalWormWriteObservationSubject({
      archivePolicy: policy,
      archiveManifest: manifest,
      writeOperationIdSha256: digest(`${operationSeed}:external-worm-write`),
      providerObservationSetSha256:
        s3Observations.writerObservationSetSha256,
      observations: s3Observations.c2WriteObservations,
      startedAt: archiveLockedAt - 1,
      lockedAt: archiveLockedAt,
      completedAt: writeCompletedAt,
    });
  const validWriteEnvelope = externalWormSignedEnvelope(
    writeSubject,
    writer,
    false,
  );
  const validReadbackSubject =
    buildJsonCompatibilityExternalWormReadbackObservationSubject({
      archivePolicy: policy,
      archiveManifest: manifest,
      writeObservationEnvelope: validWriteEnvelope,
      readbackOperationIdSha256:
        digest(`${operationSeed}:external-worm-readback`),
      providerObservationSetSha256:
        s3Observations.readbackObservationSetSha256,
      observations: s3Observations.c2ReadbackObservations,
      startedAt: archiveReadbackAt - 1,
      completedAt: archiveReadbackAt,
    });
  const validReadbackEnvelope = externalWormSignedEnvelope(
    validReadbackSubject,
    readback,
    false,
  );
  const validEvidence = buildJsonCompatibilityExternalWormArchiveEvidence({
    archivePolicy: policy,
    archiveManifest: manifest,
    writeObservationEnvelope: validWriteEnvelope,
    independentReadbackEnvelope: validReadbackEnvelope,
  });
  const validS3Closure = await buildJsonCompatibilityExternalWormS3Closure({
    archiveEvidence: validEvidence,
    target: s3Target,
    writerObservations: s3Observations.rawWriterObservations,
    readbackObservations: s3Observations.rawReadbackObservations,
  });
  const writeEnvelope = invalidWriterSignature
    ? externalWormSignedEnvelope(writeSubject, writer, true)
    : validWriteEnvelope;
  const readbackSubject = invalidWriterSignature
    ? buildJsonCompatibilityExternalWormReadbackObservationSubject({
      archivePolicy: policy,
      archiveManifest: manifest,
      writeObservationEnvelope: writeEnvelope,
      readbackOperationIdSha256:
        digest(`${operationSeed}:external-worm-readback`),
      providerObservationSetSha256:
        s3Observations.readbackObservationSetSha256,
      observations: s3Observations.c2ReadbackObservations,
      startedAt: archiveReadbackAt - 1,
      completedAt: archiveReadbackAt,
    })
    : validReadbackSubject;
  const readbackEnvelope = invalidWriterSignature || invalidReadbackSignature
    ? externalWormSignedEnvelope(
      readbackSubject,
      readback,
      invalidReadbackSignature,
    )
    : validReadbackEnvelope;
  const evidence = invalidWriterSignature || invalidReadbackSignature
    ? buildJsonCompatibilityExternalWormArchiveEvidence({
      archivePolicy: policy,
      archiveManifest: manifest,
      writeObservationEnvelope: writeEnvelope,
      independentReadbackEnvelope: readbackEnvelope,
    })
    : validEvidence;
  const s3Closure = evidence === validEvidence
    ? validS3Closure
    : rebindExternalWormS3ClosureEvidence(validS3Closure, evidence);
  return {
    writer,
    readback,
    policy,
    manifest,
    evidence,
    s3Closure,
    collectionCaptureTerminal: collectionPass.captureTerminal,
    independentReadbackCaptureTerminal: readbackPass.captureTerminal,
  };
}

function externalWormActor(role, keyPair) {
  const keys = keyPair ?? generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const spkiBase64url = Buffer.from(spki).toString("base64url");
  return {
    privateKey: keys.privateKey,
    policy: {
      keyId: `external-worm-${role}-key`,
      spkiSha256: createHash("sha256").update(spki).digest("hex"),
      spkiBase64url,
      principalIdentitySha256: digest(`external-worm-${role}-principal`),
      credentialIdSha256: digest(`external-worm-${role}-credential`),
      permissionSetSha256: digest(`external-worm-${role}-permission-set`),
    },
  };
}

function externalWormPassFixture(artifact) {
  const mode = artifact.mode;
  const captureManifestSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-v1",
    environment: "staging",
    mode,
    accountIdSha256: artifact.accountIdSha256,
    collectionProfileSha256: artifact.collectionProfileSha256,
    collectorIdentitySha256:
      artifact.collectorIdentity.collectorIdentitySha256,
  };
  const captureManifest = {
    ...captureManifestSubject,
    captureManifestSha256: sha256Canonical(captureManifestSubject),
  };
  const rawObjects = [];
  const pageObjects = [];
  for (const receipt of artifact.snapshot.pageReceipts) {
    const prefix = [
      String(receipt.sequence).padStart(6, "0"),
      receipt.resourceFamily,
      receipt.pageReceiptSha256,
    ].join("-");
    const receiptMetrics = canonicalDocumentMetrics(receipt);
    rawObjects.push(
      externalWormRawObject({
        receipt,
        objectKind: "body",
        fileName: `${prefix}.body.json`,
        byteLength: receipt.responseByteLength,
        contentSha256: receipt.responseBodySha256,
      }),
      externalWormRawObject({
        receipt,
        objectKind: "receipt",
        fileName: `${prefix}.receipt.json`,
        byteLength: receiptMetrics.byteLength,
        contentSha256: receiptMetrics.bodySha256,
      }),
    );
    pageObjects.push(
      externalWormObjectDescriptor({
        logicalRole: "raw-response-body",
        mode,
        sequence: receipt.sequence,
        resourceFamily: receipt.resourceFamily,
        contentIdentitySha256: receipt.responseBodySha256,
        bodySha256: receipt.responseBodySha256,
        byteLength: receipt.responseByteLength,
        pageReceiptSha256: receipt.pageReceiptSha256,
      }),
      externalWormObjectDescriptor({
        logicalRole: "page-receipt",
        mode,
        sequence: receipt.sequence,
        resourceFamily: receipt.resourceFamily,
        contentIdentitySha256: receipt.pageReceiptSha256,
        bodySha256: receiptMetrics.bodySha256,
        byteLength: receiptMetrics.byteLength,
        pageReceiptSha256: receipt.pageReceiptSha256,
      }),
    );
  }
  const artifactMetrics = canonicalDocumentMetrics(artifact);
  const rawObjectTotalBytes = rawObjects.reduce(
    (total, value) => total + value.byteLength,
    0,
  );
  const captureTerminalSubject = {
    schemaVersion: 1,
    contract:
      "cinatoken-container-runtime-json-compatibility-account-binding-raw-capture-terminal-v1",
    kind:
      "container-runtime-json-compatibility-account-binding-raw-capture-terminal",
    environment: "staging",
    mode,
    accountIdSha256: artifact.accountIdSha256,
    collectionProfileSha256: artifact.collectionProfileSha256,
    collectorIdentitySha256:
      artifact.collectorIdentity.collectorIdentitySha256,
    captureManifestSha256: captureManifest.captureManifestSha256,
    collectionArtifactSha256: artifact.collectionArtifactSha256,
    collectionArtifactFileSha256: artifactMetrics.bodySha256,
    pageCount: artifact.snapshot.pageReceipts.length,
    pageChainHeadSha256: artifact.snapshot.pageChainHeadSha256,
    rawObjectCount: rawObjects.length,
    rawObjectTotalBytes,
    rawObjectSetSha256: sha256Canonical(rawObjects),
    rawObjects,
  };
  const captureTerminal = {
    ...captureTerminalSubject,
    captureTerminalSha256: sha256Canonical(captureTerminalSubject),
  };
  const captureManifestMetrics = canonicalDocumentMetrics(captureManifest);
  const captureTerminalMetrics = canonicalDocumentMetrics(captureTerminal);
  return {
    captureManifest,
    captureTerminal,
    rootInput: {
      mode,
      credentialReceiptSha256:
        artifact.authenticationIdentity.credentialReceiptSha256,
      custodianIdentitySha256:
        artifact.authenticationIdentity.custodianIdentitySha256,
      authenticationIdentitySha256:
        artifact.authenticationIdentity.authenticationIdentitySha256,
      collectionArtifactSha256: artifact.collectionArtifactSha256,
      snapshotSha256: artifact.snapshot.snapshotSha256,
      pageChainHeadSha256: artifact.snapshot.pageChainHeadSha256,
      captureManifestSha256: captureManifest.captureManifestSha256,
      captureTerminalSha256: captureTerminal.captureTerminalSha256,
      observedAt: artifact.observedAt,
    },
    objects: [
      externalWormObjectDescriptor({
        logicalRole: "capture-manifest",
        mode,
        contentIdentitySha256: captureManifest.captureManifestSha256,
        ...captureManifestMetrics,
      }),
      externalWormObjectDescriptor({
        logicalRole: "capture-terminal",
        mode,
        contentIdentitySha256: captureTerminal.captureTerminalSha256,
        ...captureTerminalMetrics,
      }),
      externalWormObjectDescriptor({
        logicalRole: "collection-artifact",
        mode,
        contentIdentitySha256: artifact.collectionArtifactSha256,
        ...artifactMetrics,
      }),
      ...pageObjects,
    ],
  };
}

function externalWormRawObject({
  receipt,
  objectKind,
  fileName,
  byteLength,
  contentSha256,
}) {
  return {
    sequence: receipt.sequence,
    resourceFamily: receipt.resourceFamily,
    objectKind,
    fileName,
    byteLength,
    contentSha256,
    pageReceiptSha256: receipt.pageReceiptSha256,
    requestPathSha256: receipt.requestPathSha256,
    responseBodySha256: receipt.responseBodySha256,
  };
}

function externalWormGlobalObject(logicalRole, value, identitySha256) {
  return externalWormObjectDescriptor({
    logicalRole,
    mode: null,
    contentIdentitySha256: identitySha256,
    ...canonicalDocumentMetrics(value),
  });
}

function externalWormObjectDescriptor({
  logicalRole,
  mode,
  sequence = null,
  resourceFamily = null,
  contentIdentitySha256,
  bodySha256,
  byteLength,
  pageReceiptSha256 = null,
}) {
  return buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
    logicalRole,
    mode,
    sequence,
    resourceFamily,
    objectKeySha256: digest([
      "external-worm-object",
      mode ?? "global",
      logicalRole,
      sequence ?? 0,
      contentIdentitySha256,
    ].join(":")),
    contentIdentitySha256,
    bodySha256,
    byteLength,
    pageReceiptSha256,
  });
}

async function externalWormS3Observations({
  objects,
  operationSeed,
  target,
  writerCredentialIdSha256,
  readerCredentialIdSha256,
  writerObservedAt,
  readbackObservedAt,
  retainUntil,
}) {
  const writerObservedAtIso = epochSecondsToIso(writerObservedAt);
  const readbackObservedAtIso = epochSecondsToIso(readbackObservedAt);
  const retainUntilIso = epochSecondsToIso(retainUntil);
  const rawWriterObservations = objects.map((object) => {
    const objectTarget = {
      region: target.region,
      bucketNameSha256: target.bucketNameSha256,
      objectKeySha256: object.objectKeySha256,
      expectedBucketOwnerSha256: target.expectedBucketOwnerSha256,
    };
    const versionId = `version-${object.objectKeySha256}`;
    const eTag = `\"${object.bodySha256}\"`;
    const checksumSha256Base64 = Buffer.from(
      object.bodySha256,
      "hex",
    ).toString("base64");
    const metadata = {
      "cinatoken-content-length": String(object.byteLength),
      "cinatoken-content-sha256": object.bodySha256,
      "cinatoken-retain-until": retainUntilIso,
    };
    const requested = {
      contentLength: object.byteLength,
      contentSha256: object.bodySha256,
      checksumSha256Base64,
      contentType: object.mediaType,
      metadata,
      metadataSha256: sha256Canonical(metadata),
      objectLockMode: "COMPLIANCE",
      retainUntil: retainUntilIso,
    };
    return {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
      provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
      decisionScope: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
      authorizesC2Closure: false,
      operation: "put-object",
      observedAt: writerObservedAtIso,
      target: objectTarget,
      credential: {
        role: "writer",
        credentialIdSha256: writerCredentialIdSha256,
        expiresAt: epochSecondsToIso(writerObservedAt + 30 * 60),
      },
      requested: { ifNoneMatch: "*", ...requested },
      providerResponse: {
        versionId,
        versionIdSha256: digest(versionId),
        eTag,
        eTagSha256: digest(eTag),
        checksumSha256Base64,
        httpStatusCode: 200,
        providerRequestIdSha256: digest(
          `${operationSeed}:s3:put:${object.objectKeySha256}`,
        ),
      },
      providerReadback: null,
      classification: "observed",
      providerCallsAttempted: 1,
      retryPerformed: false,
    };
  });
  const rawReadbackObservations = rawWriterObservations.map((writerValue) => {
    const objectKeySha256 = writerValue.target.objectKeySha256;
    const requested = {
      versionId: writerValue.providerResponse.versionId,
      versionIdSha256: writerValue.providerResponse.versionIdSha256,
      eTag: writerValue.providerResponse.eTag,
      eTagSha256: writerValue.providerResponse.eTagSha256,
      checksumMode: "ENABLED",
      ...withoutProperty(writerValue.requested, "ifNoneMatch"),
    };
    const objectReadback = {
      ...withoutProperty(requested, "checksumMode"),
      providerRequestIdSha256: digest(
        `${operationSeed}:s3:get-object:${objectKeySha256}`,
      ),
    };
    return {
      schemaVersion: 1,
      contract: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_OBSERVATION_CONTRACT,
      provider: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_PROVIDER,
      decisionScope: JSON_COMPATIBILITY_EXTERNAL_WORM_S3_DECISION_SCOPE,
      authorizesC2Closure: false,
      operation: "independent-readback",
      observedAt: readbackObservedAtIso,
      target: writerValue.target,
      credential: {
        role: "reader",
        credentialIdSha256: readerCredentialIdSha256,
        expiresAt: epochSecondsToIso(readbackObservedAt + 30 * 60),
      },
      writerCredentialIdSha256,
      requested,
      providerReadback: {
        bucket: {
          versioning: "Enabled",
          objectLock: "Enabled",
          versioningRequestIdSha256: digest(
            `${operationSeed}:s3:bucket-versioning:${objectKeySha256}`,
          ),
          objectLockRequestIdSha256: digest(
            `${operationSeed}:s3:bucket-object-lock:${objectKeySha256}`,
          ),
        },
        object: objectReadback,
        retention: {
          objectLockMode: "COMPLIANCE",
          retainUntil: retainUntilIso,
          providerRequestIdSha256: digest(
            `${operationSeed}:s3:get-retention:${objectKeySha256}`,
          ),
        },
      },
      classification: "observed",
      providerCallsAttempted: 4,
      retryPerformed: false,
    };
  });
  const c2WriteObservations = rawWriterObservations.map((value, index) =>
    buildJsonCompatibilityExternalWormArchiveObjectObservation({
      objectDescriptor: objects[index],
      objectVersionSha256: value.providerResponse.versionIdSha256,
      objectEtagSha256: value.providerResponse.eTagSha256,
      retainUntil,
      providerRequestIdSha256:
        value.providerResponse.providerRequestIdSha256,
      observedAt: writerObservedAt,
    }));
  const c2ReadbackObservations = await Promise.all(
    rawReadbackObservations.map(async (value, index) =>
      buildJsonCompatibilityExternalWormArchiveObjectObservation({
        objectDescriptor: objects[index],
        objectVersionSha256: value.requested.versionIdSha256,
        objectEtagSha256: value.requested.eTagSha256,
        retainUntil,
        providerRequestIdSha256:
          await deriveJsonCompatibilityExternalWormS3ReadbackRequestSetSha256(
            value,
          ),
        observedAt: readbackObservedAt,
      })),
  );
  return {
    rawWriterObservations,
    rawReadbackObservations,
    writerObservationSetSha256: sha256Canonical(rawWriterObservations),
    readbackObservationSetSha256: sha256Canonical(rawReadbackObservations),
    c2WriteObservations,
    c2ReadbackObservations,
  };
}

function rebindExternalWormS3ClosureEvidence(closure, evidence) {
  const { closureSha256: _oldClosureSha256, ...subject } = closure;
  const rebound = {
    ...subject,
    archiveEvidenceSha256: evidence.archiveEvidenceSha256,
  };
  return { ...rebound, closureSha256: sha256Canonical(rebound) };
}

function driftExternalWormS3ProviderObservationMetadata(input) {
  const closure = structuredClone(input);
  const writerMetadata = {
    ...closure.rawWriterObservations[0].requested.metadata,
    "fixture-drift": "true",
  };
  const readbackMetadata = {
    ...closure.rawReadbackObservations[0].requested.metadata,
    "fixture-drift": "true",
  };
  closure.rawWriterObservations[0].requested.metadata = writerMetadata;
  closure.rawWriterObservations[0].requested.metadataSha256 =
    sha256Canonical(writerMetadata);
  closure.rawReadbackObservations[0].requested.metadata = readbackMetadata;
  closure.rawReadbackObservations[0].requested.metadataSha256 =
    sha256Canonical(readbackMetadata);
  closure.rawReadbackObservations[0].providerReadback.object.metadata =
    readbackMetadata;
  closure.rawReadbackObservations[0].providerReadback.object.metadataSha256 =
    sha256Canonical(readbackMetadata);
  const { closureSha256: _oldClosureSha256, ...subject } = closure;
  return { ...subject, closureSha256: sha256Canonical(subject) };
}

function epochSecondsToIso(value) {
  return new Date(value * 1000).toISOString();
}

function withoutProperty(value, property) {
  const clone = { ...value };
  delete clone[property];
  return clone;
}

function externalWormSignedEnvelope(subject, actor, invalidSignature) {
  const signature = invalidSignature
    ? Buffer.alloc(64, subject.attestationRole === "writer" ? 0x31 : 0x32)
    : sign(
      null,
      externalWormArchiveAttestationSigningPayload(subject),
      actor.privateKey,
    );
  return buildJsonCompatibilityExternalWormAttestationEnvelope({
    subject,
    signerSpkiBase64url: actor.policy.spkiBase64url,
    signatureBase64url: signature.toString("base64url"),
  });
}

function canonicalDocumentMetrics(value) {
  const body = `${canonicalJson(value)}\n`;
  return {
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    byteLength: Buffer.byteLength(body, "utf8"),
  };
}

function differentSha256(value) {
  return `${value.startsWith("0") ? "1" : "0"}${value.slice(1)}`;
}

export function createAccountBindingCredentialProvenanceFixture({
  accountIdSha256,
  collectionCredentialIdSha256,
  readbackCredentialIdSha256,
  now,
}) {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const keyId = "account-binding-credential-authority-2026-08";
  const trustPolicy =
    buildJsonCompatibilityAccountBindingCredentialTrustPolicy({
      effectiveAt: now - 120,
      current: {
        keyId,
        spkiSha256: createHash("sha256").update(spki).digest("hex"),
        spkiBase64url: Buffer.from(spki).toString("base64url"),
      },
    });
  const permissionGrants = [
    {
      permissionGroupId: "workers-scripts-read",
      name: "Workers Scripts Read",
      access: "read",
    },
    {
      permissionGroupId: "workers-routes-read",
      name: "Workers Routes Read",
      access: "read",
    },
    {
      permissionGroupId: "zone-read",
      name: "Zone Read",
      access: "read",
    },
  ];
  const receipt = (role, credentialIdSha256, custodianSeed) => {
    const subject =
      buildJsonCompatibilityAccountBindingCredentialReceiptSubject({
        accountIdSha256,
        role,
        credentialIdSha256,
        permissionGrants,
        createdAt: now - 60,
        expiresAt: now + 30 * 60,
        issuingPrincipalIdentitySha256:
          digest("account-binding-credential-issuing-principal"),
        custodianIdentitySha256: digest(custodianSeed),
        approverIdentitySha256s: [
          digest("account-binding-credential-approver-security"),
          digest("account-binding-credential-approver-operations"),
        ],
        approvalPolicySha256:
          digest("account-binding-credential-two-person-policy"),
        keyId,
      });
    return buildJsonCompatibilityAccountBindingCredentialReceiptEnvelope({
      subject,
      signatureBase64url: sign(
        null,
        accountBindingCredentialSigningPayload(subject),
        keys.privateKey,
      ).toString("base64url"),
    });
  };
  const collectionReceipt = receipt(
    "collection",
    collectionCredentialIdSha256,
    "account-binding-collection-custodian",
  );
  const readbackReceipt = receipt(
    "independent-readback",
    readbackCredentialIdSha256,
    "account-binding-readback-custodian",
  );
  const revocationSubject =
    buildJsonCompatibilityAccountBindingCredentialRevocationSubject({
      sequence: 1,
      revokedCredentialIdSha256s: [],
      revokedReceiptSubjectSha256s: [],
      issuedAt: now,
      expiresAt: now + 15 * 60,
      keyId,
    });
  const revocation =
    buildJsonCompatibilityAccountBindingCredentialRevocationEnvelope({
      subject: revocationSubject,
      signatureBase64url: sign(
        null,
        accountBindingCredentialSigningPayload(revocationSubject),
        keys.privateKey,
      ).toString("base64url"),
    });
  return buildJsonCompatibilityAccountBindingCredentialProvenance({
    trustPolicy,
    collectionReceipt,
    readbackReceipt,
    revocation,
  });
}

function buildAccountBindingEvidenceFixture({
  campaignPlan,
  statePlan,
  accountIdSha256,
  observedAt,
}) {
  const collectorIdentity =
    buildJsonCompatibilityAccountBindingCollectorIdentity({
      sourceRevisionSha256: digest("account-binding-collector-revision"),
      sourceTreeSha256: digest("account-binding-collector-tree"),
      executableSha256: digest("account-binding-collector-executable"),
      dependencyLockSha256: digest("account-binding-collector-lock"),
    });
  const credentialProvenance =
    createAccountBindingCredentialProvenanceFixture({
      accountIdSha256,
      collectionCredentialIdSha256:
        digest("account-binding-collection-credential"),
      readbackCredentialIdSha256:
        digest("account-binding-readback-credential"),
      now: observedAt - 60,
    });
  const roleServices = Object.fromEntries(
    Object.entries(statePlan.services).map(([role, service]) => [
      role,
      service.serviceName,
    ]),
  );
  const extraServices = [
    "cinatoken-rust-api-staging",
    "cinatoken-container-egress-staging",
    "cinatoken-container-runtime-json-compatibility-transition-staging",
  ];
  const serviceNames = [
    ...Object.values(roleServices),
    ...extraServices,
  ].sort();
  const versionByService = new Map(
    serviceNames.map((name, index) => [name, `fixture-version-${index + 1}`]),
  );
  const edge = (
    callerServiceName,
    bindingName,
    targetServiceName,
    targetEntrypoint,
  ) => ({
    bindingType: "service",
    callerServiceName,
    callerVersionId: versionByService.get(callerServiceName),
    bindingName,
    targetServiceName,
    targetEnvironment: null,
    targetEntrypoint,
  });
  const serviceBindingEdges = [
    edge(
      "cinatoken-rust-api-staging",
      "CONTAINER_CONTROLLER",
      roleServices.controller,
      statePlan.services.controller.entrypoint,
    ),
    edge(
      roleServices.controller,
      "PROVIDER_EGRESS",
      "cinatoken-container-egress-staging",
      null,
    ),
    edge(
      roleServices.executor,
      "CONTAINER_CONTROLLER_JSON_PROBE",
      roleServices.controller,
      statePlan.services.controller.entrypoint,
    ),
    edge(
      roleServices.invoker,
      "JSON_COMPATIBILITY_PERMIT_ISSUER_SERVICE",
      roleServices.permitIssuer,
      statePlan.services.permitIssuer.entrypoint,
    ),
    edge(
      roleServices.invoker,
      "JSON_COMPATIBILITY_EXECUTOR_SERVICE",
      roleServices.executor,
      statePlan.services.executor.entrypoint,
    ),
    edge(
      roleServices.operator,
      "JSON_COMPATIBILITY_INVOKER_SERVICE",
      roleServices.invoker,
      statePlan.services.invoker.entrypoint,
    ),
    edge(
      roleServices.runner,
      "JSON_COMPATIBILITY_OPERATOR_SERVICE",
      roleServices.operator,
      statePlan.services.operator.entrypoint,
    ),
    edge(
      roleServices.caller,
      "JSON_COMPATIBILITY_RUNNER_SERVICE",
      roleServices.runner,
      statePlan.services.runner.entrypoint,
    ),
  ];
  const campaignServiceNames = new Set(Object.values(roleServices));
  const allowedCampaignBindingEdges = serviceBindingEdges
    .filter((value) =>
      campaignServiceNames.has(value.callerServiceName)
      || campaignServiceNames.has(value.targetServiceName))
    .map(({ callerVersionId: _ignored, ...value }) => value);
  const collectionProfile =
    buildJsonCompatibilityAccountBindingCollectionProfile({
      campaignPlan,
      statePlan,
      accountIdSha256,
      collectorIdentitySha256: collectorIdentity.collectorIdentitySha256,
      credentialProvenance,
      credentialProvenanceApprovedAt: observedAt - 60,
      allowedCampaignBindingEdges,
    });
  const services = serviceNames.map((serviceName) => ({
    serviceName,
    activeVersionIds: [versionByService.get(serviceName)],
    workersDev: false,
    previewUrls: false,
    deploymentSetSha256: digest(`deployment-set:${serviceName}`),
    versionBindingSetSha256: sha256Canonical(
      serviceBindingEdges.filter(
        (value) => value.callerServiceName === serviceName,
      ).sort((left, right) => {
        const leftValue = canonicalJson(left);
        const rightValue = canonicalJson(right);
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      }),
    ),
  }));
  const zoneIdSha256s = [digest("account-zone:cinatoken.com")];
  const collectionObservedAt = observedAt - 5;
  const collectionSnapshot = buildJsonCompatibilityAccountBindingSnapshot({
    accountIdSha256,
    services,
    zoneIdSha256s,
    routes: [],
    serviceBindingEdges,
    pageReceipts: accountBindingPageReceipts(
      "collection",
      collectionObservedAt,
      { accountIdSha256, services, zoneIdSha256s },
    ),
    observedAt: collectionObservedAt,
  });
  const readbackSnapshot = buildJsonCompatibilityAccountBindingSnapshot({
    accountIdSha256,
    services,
    zoneIdSha256s,
    routes: [],
    serviceBindingEdges,
    pageReceipts: accountBindingPageReceipts(
      "readback",
      observedAt,
      { accountIdSha256, services, zoneIdSha256s },
    ),
    observedAt,
  });
  const collectionAuthentication =
    buildJsonCompatibilityAccountBindingAuthenticationIdentity({
      accountIdSha256,
      credentialIdSha256:
        credentialProvenance.collectionCredentialIdSha256,
      permissionSetSha256:
        credentialProvenance.collectionPermissionSetSha256,
      credentialVerificationPageReceiptSha256:
        collectionSnapshot.pageReceipts[0].pageReceiptSha256,
      credentialVerificationResponseBodySha256:
        collectionSnapshot.pageReceipts[0].responseBodySha256,
      credentialReceiptSha256:
        credentialProvenance.collectionCredentialReceiptSha256,
      custodianIdentitySha256:
        credentialProvenance.collectionCustodianIdentitySha256,
      credentialTrustPolicySha256:
        credentialProvenance.credentialTrustPolicySha256,
      credentialRevocationStateSha256:
        credentialProvenance.credentialRevocationStateSha256,
      credentialProvenanceSha256:
        credentialProvenance.credentialProvenanceSha256,
      verifiedAt: collectionObservedAt - 1,
    });
  const readbackAuthentication =
    buildJsonCompatibilityAccountBindingAuthenticationIdentity({
      accountIdSha256,
      credentialIdSha256:
        credentialProvenance.readbackCredentialIdSha256,
      permissionSetSha256:
        credentialProvenance.readbackPermissionSetSha256,
      credentialVerificationPageReceiptSha256:
        readbackSnapshot.pageReceipts[0].pageReceiptSha256,
      credentialVerificationResponseBodySha256:
        readbackSnapshot.pageReceipts[0].responseBodySha256,
      credentialReceiptSha256:
        credentialProvenance.readbackCredentialReceiptSha256,
      custodianIdentitySha256:
        credentialProvenance.readbackCustodianIdentitySha256,
      credentialTrustPolicySha256:
        credentialProvenance.credentialTrustPolicySha256,
      credentialRevocationStateSha256:
        credentialProvenance.credentialRevocationStateSha256,
      credentialProvenanceSha256:
        credentialProvenance.credentialProvenanceSha256,
      verifiedAt: observedAt - 1,
    });
  const collection =
    buildJsonCompatibilityAccountBindingCollectionArtifact({
      campaignPlan,
      statePlan,
      collectionProfile,
      mode: "collection",
      collectorIdentity,
      authenticationIdentity: collectionAuthentication,
      snapshot: collectionSnapshot,
    });
  const independentReadback =
    buildJsonCompatibilityAccountBindingCollectionArtifact({
      campaignPlan,
      statePlan,
      collectionProfile,
      mode: "independent-readback",
      collectorIdentity,
      authenticationIdentity: readbackAuthentication,
      snapshot: readbackSnapshot,
    });
  return buildJsonCompatibilityAccountBindingEvidence({
    campaignPlan,
    statePlan,
    collectionProfile,
    collection,
    independentReadback,
  });
}

function accountBindingPageReceipts(
  seed,
  observedAt,
  { accountIdSha256, services, zoneIdSha256s },
) {
  const accountIdentitySha256 = sha256Canonical({ accountIdSha256 });
  const schedule = [
    {
      resourceFamily: "credential-verification",
      resourceIdentitySha256: accountIdentitySha256,
      resultCount: 1,
      pageNumber: null,
      totalPages: null,
    },
    {
      resourceFamily: "workers-scripts",
      resourceIdentitySha256: accountIdentitySha256,
      resultCount: services.length,
      pageNumber: null,
      totalPages: null,
    },
    ...services.map((service) => ({
      resourceFamily: "worker-deployments",
      resourceIdentitySha256: sha256Canonical({
        serviceName: service.serviceName,
      }),
      resultCount: 1,
      pageNumber: null,
      totalPages: null,
    })),
    ...services.flatMap((service) => service.activeVersionIds.map(
      (versionId) => ({
        resourceFamily: "worker-version",
        resourceIdentitySha256: sha256Canonical({
          serviceName: service.serviceName,
          versionId,
        }),
        resultCount: 1,
        pageNumber: null,
        totalPages: null,
      }),
    )),
    ...services.map((service) => ({
      resourceFamily: "worker-subdomain",
      resourceIdentitySha256: sha256Canonical({
        serviceName: service.serviceName,
      }),
      resultCount: 1,
      pageNumber: null,
      totalPages: null,
    })),
    {
      resourceFamily: "account-worker-domains",
      resourceIdentitySha256: accountIdentitySha256,
      resultCount: 0,
      pageNumber: 1,
      totalPages: 1,
    },
    {
      resourceFamily: "account-zones",
      resourceIdentitySha256: accountIdentitySha256,
      resultCount: zoneIdSha256s.length,
      pageNumber: 1,
      totalPages: 1,
    },
    ...zoneIdSha256s.map((zoneIdSha256) => ({
      resourceFamily: "zone-worker-routes",
      resourceIdentitySha256: sha256Canonical({ zoneIdSha256 }),
      resultCount: 0,
      pageNumber: null,
      totalPages: null,
    })),
  ];
  const receipts = [];
  for (let index = 0; index < schedule.length; index += 1) {
    const page = schedule[index];
    receipts.push(buildJsonCompatibilityAccountBindingPageReceipt({
      sequence: index + 1,
      resourceFamily: page.resourceFamily,
      resourceIdentitySha256: page.resourceIdentitySha256,
      requestPathSha256: digest(`${seed}:path:${index}:${page.resourceFamily}`),
      responseBodySha256: digest(`${seed}:body:${index}:${page.resourceFamily}`),
      responseByteLength: 256 + index,
      resultCount: page.resultCount,
      pageNumber: page.pageNumber,
      totalPages: page.totalPages,
      requestIdSha256: digest(`${seed}:request:${index}:${page.resourceFamily}`),
      predecessorSha256:
        receipts.length === 0
          ? null
          : receipts[receipts.length - 1].pageReceiptSha256,
      observedAt: observedAt - 1,
    }));
  }
  if (
    new Set(receipts.map((value) => value.resourceFamily)).size
      !== JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES.length
  ) throw new Error("account binding fixture resource schedule drifted");
  return receipts;
}

function sourceArtifactObservations(statePlan) {
  const values = [];
  for (const [role, service] of Object.entries(statePlan.services)) {
    for (const [artifact, frozen] of Object.entries(service.artifacts)) {
      values.push({
        role,
        artifact,
        serviceName: service.serviceName,
        entrypoint: service.entrypoint,
        deploymentState: frozen.deploymentState,
        versionId: frozen.versionId,
        configSha256: frozen.configSha256,
        gates: structuredClone(frozen.gates),
        privateRpcOnly: service.privateRpcOnly,
        workersDev: service.workersDev,
        previewUrls: service.previewUrls,
        bindingSetSha256: digest(`bindings:${role}:${artifact}`),
        routeSetSha256: sha256Canonical([]),
        secretNameSetSha256: digest(`secrets:${role}:${artifact}`),
        durableObjectMigrationSetSha256:
          digest(`migrations:${role}:${artifact}`),
      });
    }
  }
  return values.sort((left, right) =>
    `${left.role}:${left.artifact}`.localeCompare(
      `${right.role}:${right.artifact}`,
    ));
}
