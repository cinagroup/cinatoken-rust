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
  sourceSignerTrustSlot = "current",
  sourceVerifierVersionId = "source-verifier-version-001",
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
    const immutableSourceArchiveSha256 = sha256Canonical({
      transitionSourceManifestSha256:
        transitionSourceManifest.transitionSourceManifestSha256,
      phaseSourceManifestSha256:
        phaseSourceManifest?.sourceManifestSha256 ?? null,
      artifactInventoryReadbackSha256:
        artifactInventoryReadback.artifactInventoryReadbackSha256,
      accountBindingEvidenceSha256:
        accountBindingEvidence.accountBindingEvidenceSha256,
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
        accountBindingEvidenceSha256:
          accountBindingEvidence.accountBindingEvidenceSha256,
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
    };
  } finally {
    transitionPrivateKey?.fill(0);
    sourcePrivateKey?.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
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
