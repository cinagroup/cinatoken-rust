import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
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
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
  JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
  buildJsonCompatibilitySourceAccountBindingInventory,
  buildJsonCompatibilitySourceArtifactInventoryReadback,
  buildJsonCompatibilitySourceAuthenticationBundle,
  buildJsonCompatibilitySourceImmutableArchiveReceipt,
  buildJsonCompatibilitySourceSignatureEnvelope,
  buildJsonCompatibilitySourceSignatureSubject,
  buildJsonCompatibilitySourceVerifierPolicy,
  buildJsonCompatibilityTransitionSourceManifest,
  sourceAuthenticationBundleKey,
  sourceSignatureSigningPayload,
} from "../../tools/container_runtime_json_compatibility_source_authentication.mjs";
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
  sourceSignerTrustSlot = "current",
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
    const campaignServiceNames = Object.values(statePlan.services)
      .map((service) => service.serviceName)
      .sort();
    const accountBindingInventory =
      buildJsonCompatibilitySourceAccountBindingInventory({
        campaignPlan,
        statePlan,
        accountIdSha256,
        accountServiceNameSetSha256: sha256Canonical(campaignServiceNames),
        accountRouteSetSha256: sha256Canonical([]),
        accountServiceBindingEdgeSetSha256: sha256Canonical([
          "caller->runner",
          "invoker->operator",
          "operator->runner",
          "runner->caller",
        ]),
        accountServiceCount: campaignServiceNames.length + 3,
        accountRouteCount: 0,
        accountServiceBindingEdgeCount: 4,
        cloudflareApiRequestCount: 4,
        cloudflareApiPageCount: 4,
        paginationComplete: true,
        collectorIdentitySha256: digest("source-inventory-collector"),
        authenticationIdentitySha256:
          digest("source-inventory-authentication"),
        pageChainHeadSha256: digest("source-inventory-page-chain"),
        readbackEvidenceSha256: digest("source-inventory-readback"),
        observedAt,
      });
    const immutableSourceArchiveSha256 = sha256Canonical({
      transitionSourceManifestSha256:
        transitionSourceManifest.transitionSourceManifestSha256,
      phaseSourceManifestSha256:
        phaseSourceManifest?.sourceManifestSha256 ?? null,
      artifactInventoryReadbackSha256:
        artifactInventoryReadback.artifactInventoryReadbackSha256,
      accountBindingInventorySha256:
        accountBindingInventory.accountBindingInventorySha256,
      archiveFormat: "tar.zst",
    });
    const immutableSourceArchiveReceipt =
      buildJsonCompatibilitySourceImmutableArchiveReceipt({
        accountIdSha256,
        transitionSourceManifestSha256:
          transitionSourceManifest.transitionSourceManifestSha256,
        phaseSourceManifestSha256:
          phaseSourceManifest?.sourceManifestSha256 ?? null,
        artifactInventoryReadbackSha256:
          artifactInventoryReadback.artifactInventoryReadbackSha256,
        accountBindingInventorySha256:
          accountBindingInventory.accountBindingInventorySha256,
        immutableSourceArchiveSha256,
        archiveObjectVersionSha256: digest("source-archive-object-version"),
        archiveObjectEtagSha256: digest("source-archive-object-etag"),
        archiveByteLength: 4_194_304,
        lockedAt: archiveLockedAt,
        retainUntil: archiveRetainUntil,
        independentlyReadBackAt: archiveReadbackAt,
        retentionEvidenceSha256: digest("source-archive-retention-evidence"),
      });
    const operationIdSha256 = digest(operationSeed);
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
        "container-runtime/json-compatibility/source-authentication/v2/sha256",
      issuer: JSON_COMPATIBILITY_SOURCE_SIGNATURE_ISSUER,
      audience: JSON_COMPATIBILITY_SOURCE_SIGNATURE_AUDIENCE,
      current: sourcePolicyCurrent,
      previous: sourcePolicyPrevious,
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
      accountBindingInventory,
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
    };
  } finally {
    transitionPrivateKey?.fill(0);
    sourcePrivateKey?.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
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
