import { describe, expect, test } from "bun:test";

import {
  sha256Canonical,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";
import {
  JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES,
  accountBindingInventoryInputFromEvidence,
  buildJsonCompatibilityAccountBindingAuthenticationIdentity,
  buildJsonCompatibilityAccountBindingCollectionArtifact,
  buildJsonCompatibilityAccountBindingEvidence,
  buildJsonCompatibilityAccountBindingPageReceipt,
  buildJsonCompatibilityAccountBindingSnapshot,
  validateJsonCompatibilityAccountBindingEvidence,
} from "../tools/container_runtime_json_compatibility_account_binding_evidence.mjs";
import {
  buildJsonCompatibilitySourceAccountBindingInventory,
  buildJsonCompatibilitySourceAuthenticationBundle,
} from "../tools/container_runtime_json_compatibility_source_authentication.mjs";
import {
  createSourceAuthenticationFixture,
} from "./fixtures/container-runtime-json-compatibility-source-authentication.mjs";
import {
  digest,
} from "./fixtures/container-runtime-json-compatibility-deployment-transition.mjs";

describe("JSON compatibility account-wide binding evidence", () => {
  test("derives exact account sets and two complete independent page chains", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = validateJsonCompatibilityAccountBindingEvidence(
      fixture.campaignPlan,
      fixture.statePlan,
      fixture.bundle.accountBindingEvidence,
    );

    expect(evidence.accountServiceCount).toBe(10);
    expect(evidence.accountRouteCount).toBe(0);
    expect(evidence.accountServiceBindingEdgeCount).toBe(8);
    expect(evidence.collection.snapshot.cloudflareApiRequestCount).toBe(35);
    expect(evidence.independentReadback.snapshot.cloudflareApiRequestCount)
      .toBe(35);
    expect(evidence.cloudflareApiRequestCount).toBe(70);
    expect(evidence.cloudflareApiPageCount).toBe(70);
    expect(JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES).toHaveLength(8);
    expect(JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES)
      .not.toContain("credential-detail");
    expect(evidence.collectionProfile.requiredResourceFamilies).toEqual(
      JSON_COMPATIBILITY_ACCOUNT_BINDING_RESOURCE_FAMILIES,
    );
    expect(evidence.collectionProfile.allowedCampaignBindingEdges)
      .toHaveLength(8);
    expect(Object.hasOwn(
      evidence.collectionProfile,
      "allowedIncomingBindingEdges",
    )).toBe(false);
    expect(evidence.collection.snapshot.serviceBindingEdges.every(
      (edge) => typeof edge.bindingType === "string",
    )).toBe(true);
    expect(
      fixture.bundle.immutableSourceArchiveReceipt.accountBindingEvidenceSha256,
    ).toBe(evidence.accountBindingEvidenceSha256);
    expect(
      fixture.bundle.sourceSignatureEnvelope.subject
        .accountBindingEvidenceSha256,
    ).toBe(evidence.accountBindingEvidenceSha256);
    expect(fixture.bundle.sourceSignatureEnvelope.subject.contract)
      .toEndWith("source-signature-subject-v2");
    expect(evidence.campaignServiceNames).toHaveLength(7);
    expect(evidence.campaignPrivateRpcOnly).toBe(true);
    expect(
      evidence.collection.authenticationIdentity.credentialIdSha256,
    ).not.toBe(
      evidence.independentReadback.authenticationIdentity.credentialIdSha256,
    );
    expect(
      evidence.collection.snapshot.accountServiceNameSetSha256,
    ).toBe(
      evidence.independentReadback.snapshot.accountServiceNameSetSha256,
    );
  });

  test("rejects an inventory whose recomputed count is detached from evidence", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = fixture.bundle.accountBindingEvidence;
    const projection = accountBindingInventoryInputFromEvidence(evidence);
    const detachedInventory =
      buildJsonCompatibilitySourceAccountBindingInventory({
        campaignPlan: fixture.campaignPlan,
        statePlan: fixture.statePlan,
        ...projection,
        accountServiceCount: projection.accountServiceCount + 1,
      });

    expect(() => buildJsonCompatibilitySourceAuthenticationBundle({
      sourceAuthenticationRequest: fixture.sourceAuthenticationRequest,
      campaignPlan: fixture.campaignPlan,
      statePlan: fixture.statePlan,
      transitionSourceManifest: fixture.bundle.transitionSourceManifest,
      phaseSourceManifest: fixture.bundle.phaseSourceManifest,
      artifactInventoryReadback: fixture.bundle.artifactInventoryReadback,
      accountBindingEvidence: evidence,
      accountBindingInventory: detachedInventory,
      immutableSourceArchiveReceipt:
        fixture.bundle.immutableSourceArchiveReceipt,
      sourceSignatureEnvelope: fixture.bundle.sourceSignatureEnvelope,
    })).toThrow(/source account binding evidence projection/i);
  });

  test("rejects a reused credential for the independent traversal", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = fixture.bundle.accountBindingEvidence;
    const reusedAuthentication =
      buildJsonCompatibilityAccountBindingAuthenticationIdentity({
        accountIdSha256: evidence.accountIdSha256,
        credentialIdSha256:
          evidence.collection.authenticationIdentity.credentialIdSha256,
        permissionSetSha256:
          evidence.collectionProfile.readbackPermissionSetSha256,
        credentialVerificationPageReceiptSha256:
          evidence.independentReadback.authenticationIdentity
            .credentialVerificationPageReceiptSha256,
        credentialVerificationResponseBodySha256:
          evidence.independentReadback.authenticationIdentity
            .credentialVerificationResponseBodySha256,
        credentialReceiptSha256:
          evidence.collectionProfile.readbackCredentialReceiptSha256,
        custodianIdentitySha256:
          evidence.collectionProfile.readbackCustodianIdentitySha256,
        credentialTrustPolicySha256:
          evidence.collectionProfile.credentialTrustPolicySha256,
        credentialRevocationStateSha256:
          evidence.collectionProfile.credentialRevocationStateSha256,
        credentialProvenanceSha256:
          evidence.collectionProfile.credentialProvenanceSha256,
        verifiedAt:
          evidence.independentReadback.authenticationIdentity.verifiedAt,
      });
    expect(() => rebuildReadback(
      fixture,
      evidence,
      evidence.independentReadback.snapshot,
      reusedAuthentication,
    )).toThrow(/account_binding_artifact_credential_ID_mismatch/);
  });

  test("rejects missing resource families and a broken predecessor chain", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const snapshot = fixture.bundle.accountBindingEvidence
      .independentReadback.snapshot;

    expect(() => buildJsonCompatibilityAccountBindingSnapshot({
      accountIdSha256: snapshot.accountIdSha256,
      services: snapshot.services,
      zoneIdSha256s: snapshot.zoneIdSha256s,
      routes: snapshot.routes,
      serviceBindingEdges: snapshot.serviceBindingEdges,
      pageReceipts: snapshot.pageReceipts.slice(0, -1),
      observedAt: snapshot.observedAt,
    })).toThrow(/account_binding_resource_family_missing/);

    const brokenPages = structuredClone(snapshot.pageReceipts);
    brokenPages[1].predecessorSha256 = digest("wrong-page-predecessor");
    expect(() => buildJsonCompatibilityAccountBindingSnapshot({
      accountIdSha256: snapshot.accountIdSha256,
      services: snapshot.services,
      zoneIdSha256s: snapshot.zoneIdSha256s,
      routes: snapshot.routes,
      serviceBindingEdges: snapshot.serviceBindingEdges,
      pageReceipts: brokenPages,
      observedAt: snapshot.observedAt,
    })).toThrow(/page receipt predecessor|page_receipt/i);
  });

  test("binds token verification, credential time, and global request order", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = fixture.bundle.accountBindingEvidence;
    const snapshot = evidence.independentReadback.snapshot;

    const detachedPages = rebuildPageChain(snapshot.pageReceipts, (pages) => {
      pages[0].responseBodySha256 = digest("detached-token-verification-body");
      return pages;
    });
    const detachedSnapshot = rebuildSnapshot(snapshot, {
      pageReceipts: detachedPages,
    });
    expect(() => rebuildReadback(
      fixture,
      evidence,
      detachedSnapshot,
    )).toThrow(/credential_verification_page_receipt_mismatch/);

    const expiredAuthentication =
      buildJsonCompatibilityAccountBindingAuthenticationIdentity({
        ...evidence.independentReadback.authenticationIdentity,
        verifiedAt:
          evidence.collectionProfile.credentialProvenance.revocation.subject
            .expiresAt,
      });
    expect(() => rebuildReadback(
      fixture,
      evidence,
      snapshot,
      expiredAuthentication,
    )).toThrow(/authentication_credential_not_current/);

    const reorderedPages = rebuildPageChain(snapshot.pageReceipts, (pages) => {
      [pages[0], pages[1]] = [pages[1], pages[0]];
      return pages;
    });
    expect(() => rebuildSnapshot(snapshot, {
      pageReceipts: reorderedPages,
    })).toThrow(/account_binding_request_schedule_order_invalid/);
  });

  test("rejects semantic drift between collection and readback", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = fixture.bundle.accountBindingEvidence;
    const services = structuredClone(evidence.independentReadback.snapshot.services);
    services[0].deploymentSetSha256 = digest("drifted-deployment-set");
    const driftedSnapshot = rebuildSnapshot(
      evidence.independentReadback.snapshot,
      { services },
    );
    const driftedReadback = rebuildReadback(
      fixture,
      evidence,
      driftedSnapshot,
    );

    expect(() => buildJsonCompatibilityAccountBindingEvidence({
      campaignPlan: fixture.campaignPlan,
      statePlan: fixture.statePlan,
      collectionProfile: evidence.collectionProfile,
      collection: evidence.collection,
      independentReadback: driftedReadback,
    })).toThrow(/independent account binding service names|mismatch/i);
  });

  test("rejects workers.dev exposure and an unapproved campaign caller", async () => {
    const fixture = await createSourceAuthenticationFixture();
    const evidence = fixture.bundle.accountBindingEvidence;
    const campaignName = evidence.campaignServiceNames[0];
    const exposedServices = structuredClone(
      evidence.independentReadback.snapshot.services,
    );
    exposedServices.find((value) => value.serviceName === campaignName)
      .workersDev = true;
    const exposedSnapshot = rebuildSnapshot(
      evidence.independentReadback.snapshot,
      { services: exposedServices },
    );
    const exposedCollectionServices = structuredClone(
      evidence.collection.snapshot.services,
    );
    exposedCollectionServices.find((value) => value.serviceName === campaignName)
      .workersDev = true;
    const exposedCollection = rebuildCollection(
      fixture,
      evidence,
      rebuildSnapshot(evidence.collection.snapshot, {
        services: exposedCollectionServices,
      }),
    );
    const exposedReadback = rebuildReadback(
      fixture,
      evidence,
      exposedSnapshot,
    );
    expect(() => buildJsonCompatibilityAccountBindingEvidence({
      campaignPlan: fixture.campaignPlan,
      statePlan: fixture.statePlan,
      collectionProfile: evidence.collectionProfile,
      collection: exposedCollection,
      independentReadback: exposedReadback,
    })).toThrow(/campaign_private_rpc_boundary_not_proven/);

    const unexpectedEdges = structuredClone(
      evidence.independentReadback.snapshot.serviceBindingEdges,
    );
    const caller = evidence.independentReadback.snapshot.services.find(
      (value) => !evidence.campaignServiceNames.includes(value.serviceName),
    );
    unexpectedEdges.push({
      bindingType: "service",
      callerServiceName: caller.serviceName,
      callerVersionId: caller.activeVersionIds[0],
      bindingName: "UNAPPROVED_CAMPAIGN_CALLER",
      targetServiceName: campaignName,
      targetEnvironment: null,
      targetEntrypoint: fixture.statePlan.services[
        evidence.collectionProfile.campaignServices.find(
          (value) => value.serviceName === campaignName,
        ).role
      ].entrypoint,
    });
    const unexpectedSnapshot = rebuildSnapshot(
      evidence.independentReadback.snapshot,
      { serviceBindingEdges: unexpectedEdges },
    );
    const collectionUnexpectedEdges = structuredClone(
      evidence.collection.snapshot.serviceBindingEdges,
    );
    collectionUnexpectedEdges.push(structuredClone(unexpectedEdges.at(-1)));
    const unexpectedCollection = rebuildCollection(
      fixture,
      evidence,
      rebuildSnapshot(evidence.collection.snapshot, {
        serviceBindingEdges: collectionUnexpectedEdges,
      }),
    );
    const unexpectedReadback = rebuildReadback(
      fixture,
      evidence,
      unexpectedSnapshot,
    );
    expect(() => buildJsonCompatibilityAccountBindingEvidence({
      campaignPlan: fixture.campaignPlan,
      statePlan: fixture.statePlan,
      collectionProfile: evidence.collectionProfile,
      collection: unexpectedCollection,
      independentReadback: unexpectedReadback,
    })).toThrow(/campaign_private_rpc_boundary_not_proven/);
  });
});

function rebuildSnapshot(snapshot, overrides) {
  const serviceBindingEdges =
    overrides.serviceBindingEdges ?? snapshot.serviceBindingEdges;
  const services = structuredClone(overrides.services ?? snapshot.services);
  if (overrides.serviceBindingEdges !== undefined) {
    for (const service of services) {
      service.versionBindingSetSha256 = sha256Canonical(
        serviceBindingEdges
          .filter((edge) => edge.callerServiceName === service.serviceName)
          .sort((left, right) => compareAscii(edgeKey(left), edgeKey(right))),
      );
    }
  }
  return buildJsonCompatibilityAccountBindingSnapshot({
    accountIdSha256: snapshot.accountIdSha256,
    services,
    zoneIdSha256s: overrides.zoneIdSha256s ?? snapshot.zoneIdSha256s,
    routes: overrides.routes ?? snapshot.routes,
    serviceBindingEdges,
    pageReceipts: overrides.pageReceipts ?? snapshot.pageReceipts,
    observedAt: snapshot.observedAt,
  });
}

function rebuildPageChain(input, transform) {
  const pages = transform(structuredClone(input));
  const rebuilt = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    rebuilt.push(buildJsonCompatibilityAccountBindingPageReceipt({
      sequence: index + 1,
      resourceFamily: page.resourceFamily,
      resourceIdentitySha256: page.resourceIdentitySha256,
      requestPathSha256: page.requestPathSha256,
      responseBodySha256: page.responseBodySha256,
      responseByteLength: page.responseByteLength,
      resultCount: page.resultCount,
      pageNumber: page.pageNumber,
      totalPages: page.totalPages,
      requestIdSha256: page.requestIdSha256,
      predecessorSha256: index === 0
        ? null
        : rebuilt[index - 1].pageReceiptSha256,
      observedAt: page.observedAt,
    }));
  }
  return rebuilt;
}

function edgeKey(edge) {
  return [
    edge.callerServiceName,
    edge.callerVersionId,
    edge.bindingType,
    edge.callerServiceName,
    edge.bindingName,
    edge.targetServiceName,
    edge.targetEnvironment ?? "",
    edge.targetEntrypoint ?? "",
  ].join("\0");
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rebuildReadback(
  fixture,
  evidence,
  snapshot,
  authenticationIdentity = evidence.independentReadback.authenticationIdentity,
) {
  return buildJsonCompatibilityAccountBindingCollectionArtifact({
    campaignPlan: fixture.campaignPlan,
    statePlan: fixture.statePlan,
    collectionProfile: evidence.collectionProfile,
    mode: "independent-readback",
    collectorIdentity: evidence.independentReadback.collectorIdentity,
    authenticationIdentity,
    snapshot,
  });
}

function rebuildCollection(fixture, evidence, snapshot) {
  return buildJsonCompatibilityAccountBindingCollectionArtifact({
    campaignPlan: fixture.campaignPlan,
    statePlan: fixture.statePlan,
    collectionProfile: evidence.collectionProfile,
    mode: "collection",
    collectorIdentity: evidence.collection.collectorIdentity,
    authenticationIdentity: evidence.collection.authenticationIdentity,
    snapshot,
  });
}
