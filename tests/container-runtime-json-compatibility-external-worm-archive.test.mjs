import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_OBJECT_COUNT,
  JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_TOTAL_BYTES,
  JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_READBACK_DELAY_SECONDS,
  JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_READBACK_DELAY_SECONDS,
  JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS,
  JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN,
  JSON_COMPATIBILITY_EXTERNAL_WORM_WRITER_ATTESTATION_DOMAIN,
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
  validateJsonCompatibilityExternalWormArchiveEvidence,
  validateJsonCompatibilityExternalWormArchiveManifest,
  validateJsonCompatibilityExternalWormArchiveObjectDescriptor,
  validateJsonCompatibilityExternalWormArchivePolicy,
  verifyJsonCompatibilityExternalWormArchiveAttestation,
  verifyJsonCompatibilityExternalWormArchiveEvidence,
} from "../tools/container_runtime_json_compatibility_external_worm_archive.mjs";
import {
  canonicalJson,
} from "../tools/container_runtime_json_compatibility_campaign.mjs";

const NOW = 1_786_300_000;

describe("JSON compatibility external WORM archive contract", () => {
  test("binds two passes to independently signed exact WORM write and readback", () => {
    const value = fixture();
    const validated = validateJsonCompatibilityExternalWormArchiveEvidence(
      value.evidence,
    );
    const verified = verifyJsonCompatibilityExternalWormArchiveEvidence(
      validated,
      {
        expectedArchivePolicySha256: value.policy.archivePolicySha256,
        forbiddenSignerSpkiSha256s: [digest("c1-key"), digest("c4-key")],
      },
    );

    expect(verified.archiveManifest.archiveObjectCount).toBe(19);
    expect(verified.archiveManifest.collection.pageCount).toBe(1);
    expect(verified.archiveManifest.independentReadback.pageCount).toBe(1);
    expect(verified.archivePolicy.providerControl)
      .toBe("version-specific-object-lock-compliance");
    expect(verified.archivePolicy.r2BucketLockAccepted).toBe(false);
    expect(verified.archivePolicy.legalHoldRequired).toBe(false);
    for (const root of [
      verified.archiveManifest.collection,
      verified.archiveManifest.independentReadback,
    ]) {
      const terminals = verified.archiveManifest.objects.filter(
        (entry) =>
          entry.mode === root.mode
          && entry.logicalRole === "capture-terminal",
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0].contentIdentitySha256)
        .toBe(root.captureTerminalSha256);
    }
    expect(verified.writeObservationEnvelope.role).toBe("writer");
    expect(verified.independentReadbackEnvelope.role)
      .toBe("independent-readback");
    expect(
      verified.writeObservationEnvelope.subject.objectIdentitySetSha256,
    ).toBe(
      verified.independentReadbackEnvelope.subject.objectIdentitySetSha256,
    );
    expect(verified.archiveEvidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON_COMPATIBILITY_EXTERNAL_WORM_WRITER_ATTESTATION_DOMAIN)
      .not.toBe(JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN);
    expect(new TextDecoder().decode(
      externalWormArchiveAttestationSigningPayload(value.writeSubject),
    )).toStartWith(JSON_COMPATIBILITY_EXTERNAL_WORM_WRITER_ATTESTATION_DOMAIN);
    expect(new TextDecoder().decode(
      externalWormArchiveAttestationSigningPayload(value.readbackSubject),
    )).toStartWith(JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN);
  });

  test("rejects unknown keys and detached canonical digests", () => {
    const value = fixture();
    expectCode(() => validateJsonCompatibilityExternalWormArchivePolicy({
      ...value.policy,
      unexpected: true,
    }), "external_worm_document_keys_invalid");
    expectCode(() =>
      validateJsonCompatibilityExternalWormArchiveObjectDescriptor({
        ...value.objects[0],
        byteLength: value.objects[0].byteLength + 1,
      }), "external_worm_binding_mismatch");
    expectCode(() => validateJsonCompatibilityExternalWormArchiveManifest(
      value.policy,
      {
        ...value.manifest,
        archiveObjectCount: value.manifest.archiveObjectCount - 1,
      },
    ), "external_worm_binding_mismatch");
  });

  test("requires version-specific compliance without R2 lock or legal hold substitution", () => {
    const value = fixture();
    for (const [property, replacement] of [
      ["providerControl", "provider-declared-external-worm"],
      ["r2BucketLockAccepted", true],
      ["legalHoldRequired", true],
    ]) {
      expectCode(() => validateJsonCompatibilityExternalWormArchivePolicy({
        ...value.policy,
        [property]: replacement,
      }), "external_worm_binding_mismatch");
    }
  });

  test("bounds archive descriptor count and aggregate byte length", () => {
    expect(JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_OBJECT_COUNT).toBe(
      512,
    );
    const value = fixture();
    expectCode(() => buildJsonCompatibilityExternalWormArchivePassRoot({
      ...passInput(value.manifest.collection),
      objects: Array(
        JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_OBJECT_COUNT + 1,
      ).fill(value.objects[0]),
    }), "external_worm_archive_object_count_limit_exceeded");

    const global = value.objects.find(
      (entry) => entry.logicalRole === "campaign-plan",
    );
    const oversized = buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
      logicalRole: global.logicalRole,
      mode: global.mode,
      sequence: global.sequence,
      resourceFamily: global.resourceFamily,
      objectKeySha256: global.objectKeySha256,
      contentIdentitySha256: global.contentIdentitySha256,
      bodySha256: global.bodySha256,
      byteLength: JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_ARCHIVE_TOTAL_BYTES,
      pageReceiptSha256: global.pageReceiptSha256,
    });
    expectCode(() => buildJsonCompatibilityExternalWormArchiveManifest({
      ...manifestInput(value.manifest),
      archivePolicy: value.policy,
      objects: value.objects.map((entry) =>
        entry.objectDescriptorSha256 === global.objectDescriptorSha256
          ? oversized
          : entry),
    }), "external_worm_archive_total_bytes_limit_exceeded");
  });

  test("enforces writer, reader, key, credential, and operation separation", () => {
    const value = fixture();
    expectCode(() => buildJsonCompatibilityExternalWormArchivePolicy({
      backendIdentitySha256: value.policy.backendIdentitySha256,
      namespaceIdentitySha256: value.policy.namespaceIdentitySha256,
      effectiveAt: value.policy.effectiveAt,
      writer: value.policy.writer,
      readback: {
        ...value.policy.readback,
        principalIdentitySha256:
          value.policy.writer.principalIdentitySha256,
      },
    }), "external_worm_policy_identity_separation_invalid");

    expectCode(() => buildJsonCompatibilityExternalWormReadbackObservationSubject({
      archivePolicy: value.policy,
      archiveManifest: value.manifest,
      writeObservationEnvelope: value.writeEnvelope,
      readbackOperationIdSha256: value.writeSubject.writeOperationIdSha256,
      providerObservationSetSha256:
        value.readbackSubject.providerObservationSetSha256,
      observations: value.readbackObservations,
      startedAt: value.readbackSubject.startedAt,
      completedAt: value.readbackSubject.completedAt,
    }), "external_worm_operation_separation_invalid");

    expectCode(() => verifyJsonCompatibilityExternalWormArchiveEvidence(
      value.evidence,
      {
        expectedArchivePolicySha256: value.policy.archivePolicySha256,
        forbiddenSignerSpkiSha256s: [value.policy.writer.spkiSha256],
      },
    ), "external_worm_cross_domain_signer_reuse");
  });

  test("requires an exact object set and exact independent readback", () => {
    const value = fixture();
    expectCode(() => buildJsonCompatibilityExternalWormWriteObservationSubject({
      archivePolicy: value.policy,
      archiveManifest: value.manifest,
      writeOperationIdSha256: digest("missing-object-write-operation"),
      providerObservationSetSha256:
        value.writeSubject.providerObservationSetSha256,
      observations: value.writeObservations.slice(0, -1),
      startedAt: value.writeSubject.startedAt,
      lockedAt: value.writeSubject.lockedAt,
      completedAt: value.writeSubject.completedAt,
    }), "external_worm_observation_set_invalid");

    const descriptor = value.objects[0];
    const driftedObservation =
      buildJsonCompatibilityExternalWormArchiveObjectObservation({
        objectDescriptor: descriptor,
        objectVersionSha256: digest("drifted-object-version"),
        objectEtagSha256: value.readbackObservations[0].objectEtagSha256,
        retainUntil: value.readbackObservations[0].retainUntil,
        providerRequestIdSha256:
          value.readbackObservations[0].providerRequestIdSha256,
        observedAt: value.readbackObservations[0].observedAt,
      });
    expectCode(() => buildJsonCompatibilityExternalWormReadbackObservationSubject({
      archivePolicy: value.policy,
      archiveManifest: value.manifest,
      writeObservationEnvelope: value.writeEnvelope,
      readbackOperationIdSha256: digest("drifted-readback-operation"),
      providerObservationSetSha256:
        value.readbackSubject.providerObservationSetSha256,
      observations: [
        driftedObservation,
        ...value.readbackObservations.slice(1),
      ],
      startedAt: value.readbackSubject.startedAt,
      completedAt: value.readbackSubject.completedAt,
    }), "external_worm_readback_observation_mismatch");

    const body = value.objects.find(
      (entry) =>
        entry.mode === "collection"
        && entry.logicalRole === "raw-response-body",
    );
    const mismatchedBody =
      buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
        logicalRole: body.logicalRole,
        mode: body.mode,
        sequence: body.sequence,
        resourceFamily: body.resourceFamily,
        objectKeySha256: body.objectKeySha256,
        contentIdentitySha256: body.contentIdentitySha256,
        bodySha256: body.bodySha256,
        byteLength: body.byteLength,
        pageReceiptSha256: digest("detached-page-receipt"),
      });
    expectCode(() => buildJsonCompatibilityExternalWormArchivePassRoot({
      ...passInput(value.manifest.collection),
      objects: value.objects.map((entry) =>
        entry.objectDescriptorSha256 === body.objectDescriptorSha256
          ? mismatchedBody
          : entry),
    }), "external_worm_page_object_pair_invalid");
  });

  test("requires one content-bound capture terminal per pass", () => {
    const value = fixture();
    const root = value.manifest.collection;
    const terminal = value.objects.find(
      (entry) =>
        entry.mode === root.mode
        && entry.logicalRole === "capture-terminal",
    );
    expectCode(() => buildJsonCompatibilityExternalWormArchivePassRoot({
      ...passInput(root),
      objects: value.objects.filter(
        (entry) => entry.objectDescriptorSha256 !== terminal.objectDescriptorSha256,
      ),
    }), "external_worm_pass_object_set_invalid");

    const duplicate = descriptor({
      role: "capture-terminal",
      mode: root.mode,
      identity: root.captureTerminalSha256,
      objectKeySha256: digest("duplicate:collection:capture-terminal:key"),
    });
    expectCode(() => buildJsonCompatibilityExternalWormArchivePassRoot({
      ...passInput(root),
      objects: [...value.objects, duplicate],
    }), "external_worm_pass_object_set_invalid");

    const detached = buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
      logicalRole: terminal.logicalRole,
      mode: terminal.mode,
      sequence: terminal.sequence,
      resourceFamily: terminal.resourceFamily,
      objectKeySha256: terminal.objectKeySha256,
      contentIdentitySha256: digest("detached:collection:capture-terminal"),
      bodySha256: terminal.bodySha256,
      byteLength: terminal.byteLength,
      pageReceiptSha256: terminal.pageReceiptSha256,
    });
    expectCode(() => buildJsonCompatibilityExternalWormArchivePassRoot({
      ...passInput(root),
      objects: value.objects.map((entry) =>
        entry.objectDescriptorSha256 === terminal.objectDescriptorSha256
          ? detached
          : entry),
    }), "external_worm_pass_object_set_mismatch");
  });

  test("enforces 365-day retention and the five-to-900-second readback window", () => {
    const value = fixture();
    const descriptor = value.objects[0];
    const shortRetention =
      buildJsonCompatibilityExternalWormArchiveObjectObservation({
        objectDescriptor: descriptor,
        objectVersionSha256: value.writeObservations[0].objectVersionSha256,
        objectEtagSha256: value.writeObservations[0].objectEtagSha256,
        retainUntil: value.writeSubject.lockedAt
          + JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS - 1,
        providerRequestIdSha256:
          value.writeObservations[0].providerRequestIdSha256,
        observedAt: value.writeObservations[0].observedAt,
      });
    expectCode(() => buildJsonCompatibilityExternalWormWriteObservationSubject({
      archivePolicy: value.policy,
      archiveManifest: value.manifest,
      writeOperationIdSha256: digest("short-retention-write"),
      providerObservationSetSha256:
        value.writeSubject.providerObservationSetSha256,
      observations: [shortRetention, ...value.writeObservations.slice(1)],
      startedAt: value.writeSubject.startedAt,
      lockedAt: value.writeSubject.lockedAt,
      completedAt: value.writeSubject.completedAt,
    }), "external_worm_retention_invalid");

    for (const delay of [
      JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_READBACK_DELAY_SECONDS - 1,
      JSON_COMPATIBILITY_EXTERNAL_WORM_MAX_READBACK_DELAY_SECONDS + 1,
    ]) {
      expectCode(() =>
        buildJsonCompatibilityExternalWormReadbackObservationSubject({
          archivePolicy: value.policy,
          archiveManifest: value.manifest,
          writeObservationEnvelope: value.writeEnvelope,
          readbackOperationIdSha256: digest(`invalid-delay:${delay}`),
          providerObservationSetSha256:
            value.readbackSubject.providerObservationSetSha256,
          observations: value.readbackObservations,
          startedAt: value.writeSubject.completedAt + delay,
          completedAt: value.writeSubject.completedAt + delay + 1,
        }), "external_worm_readback_window_invalid");
    }

    expectCode(() => buildJsonCompatibilityExternalWormArchiveManifest({
      ...manifestInput(value.manifest),
      archivePolicy: value.policy,
      createdAt: value.manifest.independentReadback.observedAt - 1,
    }), "external_worm_manifest_time_order_invalid");
  });

  test("rejects forged, cross-domain, wrong-key, and unanchored attestations", () => {
    const value = fixture();
    const forgedEnvelope = buildJsonCompatibilityExternalWormAttestationEnvelope({
      subject: value.writeSubject,
      signerSpkiBase64url: value.writer.spkiBase64url,
      signatureBase64url: Buffer.alloc(64, 0x05).toString("base64url"),
    });
    expectCode(() => verifyJsonCompatibilityExternalWormArchiveAttestation({
      archivePolicy: value.policy,
      envelope: forgedEnvelope,
      expectedArchivePolicySha256: value.policy.archivePolicySha256,
    }), "external_worm_signature_invalid");

    const wrongDomainSignature = sign(
      null,
      new TextEncoder().encode(
        `${JSON_COMPATIBILITY_EXTERNAL_WORM_READBACK_ATTESTATION_DOMAIN}${canonicalJson(value.writeSubject)}`,
      ),
      value.writer.privateKey,
    ).toString("base64url");
    const wrongDomainEnvelope =
      buildJsonCompatibilityExternalWormAttestationEnvelope({
        subject: value.writeSubject,
        signerSpkiBase64url: value.writer.spkiBase64url,
        signatureBase64url: wrongDomainSignature,
      });
    expectCode(() => verifyJsonCompatibilityExternalWormArchiveAttestation({
      archivePolicy: value.policy,
      envelope: wrongDomainEnvelope,
      expectedArchivePolicySha256: value.policy.archivePolicySha256,
    }), "external_worm_signature_invalid");

    expectCode(() => buildJsonCompatibilityExternalWormAttestationEnvelope({
      subject: value.writeSubject,
      signerSpkiBase64url: value.readback.spkiBase64url,
      signatureBase64url: value.writeEnvelope.signatureBase64url,
    }), "external_worm_attestation_spki_digest_mismatch");

    expectCode(() => verifyJsonCompatibilityExternalWormArchiveEvidence(
      value.evidence,
      { expectedArchivePolicySha256: digest("unapproved-c2-policy") },
    ), "external_worm_attestation_policy_anchor_mismatch");
  });

  test("rejects shortened retention and reused provider requests on readback", () => {
    const value = fixture();
    const descriptor = value.objects[0];
    for (const overrides of [
      {
        retainUntil: value.writeObservations[0].retainUntil - 1,
        providerRequestIdSha256:
          value.readbackObservations[0].providerRequestIdSha256,
      },
      {
        retainUntil: value.readbackObservations[0].retainUntil,
        providerRequestIdSha256:
          value.writeObservations[0].providerRequestIdSha256,
      },
    ]) {
      const mismatched =
        buildJsonCompatibilityExternalWormArchiveObjectObservation({
          objectDescriptor: descriptor,
          objectVersionSha256:
            value.readbackObservations[0].objectVersionSha256,
          objectEtagSha256: value.readbackObservations[0].objectEtagSha256,
          retainUntil: overrides.retainUntil,
          providerRequestIdSha256: overrides.providerRequestIdSha256,
          observedAt: value.readbackObservations[0].observedAt,
        });
      expectCode(() =>
        buildJsonCompatibilityExternalWormReadbackObservationSubject({
          archivePolicy: value.policy,
          archiveManifest: value.manifest,
          writeObservationEnvelope: value.writeEnvelope,
          readbackOperationIdSha256: digest(
            `invalid-readback:${overrides.providerRequestIdSha256}`,
          ),
          providerObservationSetSha256:
            value.readbackSubject.providerObservationSetSha256,
          observations: [mismatched, ...value.readbackObservations.slice(1)],
          startedAt: value.readbackSubject.startedAt,
          completedAt: value.readbackSubject.completedAt,
        }), "external_worm_readback_observation_mismatch");
    }
  });
});

function fixture() {
  const writer = actor("writer");
  const readback = actor("readback");
  const policy = buildJsonCompatibilityExternalWormArchivePolicy({
    backendIdentitySha256: digest("external-worm-backend"),
    namespaceIdentitySha256: digest("external-worm-namespace"),
    effectiveAt: NOW - 60,
    writer: writer.policy,
    readback: readback.policy,
  });
  const roots = {
    archiveOperationIdSha256: digest("archive-operation"),
    accountIdSha256: digest("archive-account"),
    campaignPlanDigestSha256: digest("campaign-plan"),
    statePlanDigestSha256: digest("state-plan"),
    collectionProfileSha256: digest("collection-profile"),
    collectorIdentitySha256: digest("collector-identity"),
    accountBindingEvidenceSha256: digest("account-binding-evidence"),
    accountBindingInventorySha256: digest("account-binding-inventory"),
    transitionSourceManifestSha256: digest("transition-source-manifest"),
    phaseSourceManifestSha256: digest("phase-source-manifest"),
    artifactInventoryReadbackSha256: digest("artifact-inventory-readback"),
  };
  const passIdentities = {
    collection: passIdentity("collection", NOW - 10),
    independentReadback: passIdentity("independent-readback", NOW - 5),
  };
  const objects = [
    ...passObjects("collection", passIdentities.collection),
    ...passObjects("independent-readback", passIdentities.independentReadback),
    globalObject("campaign-plan", roots.campaignPlanDigestSha256),
    globalObject("state-plan", roots.statePlanDigestSha256),
    globalObject("collector-identity", roots.collectorIdentitySha256),
    globalObject("collection-profile", roots.collectionProfileSha256),
    globalObject(
      "account-binding-evidence",
      roots.accountBindingEvidenceSha256,
    ),
    globalObject(
      "account-binding-inventory",
      roots.accountBindingInventorySha256,
    ),
    globalObject(
      "transition-source-manifest",
      roots.transitionSourceManifestSha256,
    ),
    globalObject(
      "phase-source-manifest",
      roots.phaseSourceManifestSha256,
    ),
    globalObject(
      "artifact-inventory-readback",
      roots.artifactInventoryReadbackSha256,
    ),
  ];
  const collection = buildJsonCompatibilityExternalWormArchivePassRoot({
    ...passIdentities.collection,
    objects,
  });
  const independentReadback =
    buildJsonCompatibilityExternalWormArchivePassRoot({
      ...passIdentities.independentReadback,
      objects,
    });
  const manifest = buildJsonCompatibilityExternalWormArchiveManifest({
    archivePolicy: policy,
    ...roots,
    collection,
    independentReadback,
    objects,
    createdAt: NOW,
  });
  const writeStartedAt = NOW + 1;
  const lockedAt = NOW + 2;
  const writeCompletedAt = NOW + 3;
  const retainUntil = lockedAt
    + JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_RETENTION_SECONDS + 60;
  const writeObservations = observations(
    objects,
    "write",
    writeCompletedAt,
    retainUntil,
  );
  const writeSubject =
    buildJsonCompatibilityExternalWormWriteObservationSubject({
      archivePolicy: policy,
      archiveManifest: manifest,
      writeOperationIdSha256: digest("write-operation"),
      providerObservationSetSha256: digest("write-provider-observations"),
      observations: writeObservations,
      startedAt: writeStartedAt,
      lockedAt,
      completedAt: writeCompletedAt,
    });
  const writeEnvelope = signedEnvelope(writeSubject, writer);
  const readbackStartedAt = writeCompletedAt
    + JSON_COMPATIBILITY_EXTERNAL_WORM_MIN_READBACK_DELAY_SECONDS;
  const readbackCompletedAt = readbackStartedAt + 2;
  const readbackObservations = observations(
    objects,
    "readback",
    readbackCompletedAt,
    retainUntil + 30,
  );
  const readbackSubject =
    buildJsonCompatibilityExternalWormReadbackObservationSubject({
      archivePolicy: policy,
      archiveManifest: manifest,
      writeObservationEnvelope: writeEnvelope,
      readbackOperationIdSha256: digest("readback-operation"),
      providerObservationSetSha256:
        digest("readback-provider-observations"),
      observations: readbackObservations,
      startedAt: readbackStartedAt,
      completedAt: readbackCompletedAt,
    });
  const readbackEnvelope = signedEnvelope(readbackSubject, readback);
  const evidence = buildJsonCompatibilityExternalWormArchiveEvidence({
    archivePolicy: policy,
    archiveManifest: manifest,
    writeObservationEnvelope: writeEnvelope,
    independentReadbackEnvelope: readbackEnvelope,
  });
  return {
    writer,
    readback,
    policy,
    objects: manifest.objects,
    manifest,
    writeObservations: writeSubject.observations,
    writeSubject,
    writeEnvelope,
    readbackObservations: readbackSubject.observations,
    readbackSubject,
    readbackEnvelope,
    evidence,
  };
}

function actor(role) {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const spkiBase64url = Buffer.from(spki).toString("base64url");
  return {
    privateKey: keys.privateKey,
    spkiBase64url,
    policy: {
      keyId: `external-worm-${role}-key`,
      spkiSha256: createHash("sha256").update(spki).digest("hex"),
      spkiBase64url,
      principalIdentitySha256: digest(`${role}-principal`),
      credentialIdSha256: digest(`${role}-credential`),
      permissionSetSha256: digest(`${role}-permission-set`),
    },
  };
}

function passIdentity(mode, observedAt) {
  return {
    mode,
    credentialReceiptSha256: digest(`${mode}:credential-receipt`),
    custodianIdentitySha256: digest(`${mode}:custodian`),
    authenticationIdentitySha256: digest(`${mode}:authentication`),
    collectionArtifactSha256: digest(`${mode}:artifact`),
    snapshotSha256: digest(`${mode}:snapshot`),
    pageChainHeadSha256: digest(`${mode}:page-chain`),
    captureManifestSha256: digest(`${mode}:capture-manifest`),
    captureTerminalSha256: digest(`${mode}:capture-terminal`),
    observedAt,
  };
}

function passObjects(mode, identity) {
  const pageReceiptSha256 = digest(`${mode}:page-receipt`);
  const responseBodySha256 = digest(`${mode}:raw-response`);
  return [
    descriptor({
      role: "capture-manifest",
      mode,
      identity: identity.captureManifestSha256,
    }),
    descriptor({
      role: "capture-terminal",
      mode,
      identity: identity.captureTerminalSha256,
    }),
    descriptor({
      role: "raw-response-body",
      mode,
      sequence: 1,
      resourceFamily: "workers-scripts",
      identity: responseBodySha256,
      bodySha256: responseBodySha256,
      pageReceiptSha256,
    }),
    descriptor({
      role: "page-receipt",
      mode,
      sequence: 1,
      resourceFamily: "workers-scripts",
      identity: pageReceiptSha256,
      pageReceiptSha256,
    }),
    descriptor({
      role: "collection-artifact",
      mode,
      identity: identity.collectionArtifactSha256,
    }),
  ];
}

function globalObject(role, identity) {
  return descriptor({ role, mode: null, identity });
}

function descriptor({
  role,
  mode,
  identity,
  sequence = null,
  resourceFamily = null,
  bodySha256 = digest(`body:${role}:${mode ?? "global"}:${sequence ?? 0}`),
  pageReceiptSha256 = null,
  objectKeySha256 = digest(
    `key:${role}:${mode ?? "global"}:${sequence ?? 0}`,
  ),
}) {
  return buildJsonCompatibilityExternalWormArchiveObjectDescriptor({
    logicalRole: role,
    mode,
    sequence,
    resourceFamily,
    objectKeySha256,
    contentIdentitySha256: identity,
    bodySha256,
    byteLength: 100 + (sequence ?? 0),
    pageReceiptSha256,
  });
}

function observations(objects, phase, observedAt, retainUntil) {
  return objects.map((object) =>
    buildJsonCompatibilityExternalWormArchiveObjectObservation({
      objectDescriptor: object,
      objectVersionSha256: digest(`version:${object.objectKeySha256}`),
      objectEtagSha256: digest(`etag:${object.objectKeySha256}`),
      retainUntil,
      providerRequestIdSha256:
        digest(`${phase}:request:${object.objectKeySha256}`),
      observedAt,
    }));
}

function signedEnvelope(subject, actorValue) {
  return buildJsonCompatibilityExternalWormAttestationEnvelope({
    subject,
    signerSpkiBase64url: actorValue.spkiBase64url,
    signatureBase64url: sign(
      null,
      externalWormArchiveAttestationSigningPayload(subject),
      actorValue.privateKey,
    ).toString("base64url"),
  });
}

function passInput(root) {
  return {
    mode: root.mode,
    credentialReceiptSha256: root.credentialReceiptSha256,
    custodianIdentitySha256: root.custodianIdentitySha256,
    authenticationIdentitySha256: root.authenticationIdentitySha256,
    collectionArtifactSha256: root.collectionArtifactSha256,
    snapshotSha256: root.snapshotSha256,
    pageChainHeadSha256: root.pageChainHeadSha256,
    captureManifestSha256: root.captureManifestSha256,
    captureTerminalSha256: root.captureTerminalSha256,
    observedAt: root.observedAt,
  };
}

function manifestInput(value) {
  return {
    archiveOperationIdSha256: value.archiveOperationIdSha256,
    accountIdSha256: value.accountIdSha256,
    campaignPlanDigestSha256: value.campaignPlanDigestSha256,
    statePlanDigestSha256: value.statePlanDigestSha256,
    collectionProfileSha256: value.collectionProfileSha256,
    collectorIdentitySha256: value.collectorIdentitySha256,
    collection: value.collection,
    independentReadback: value.independentReadback,
    accountBindingEvidenceSha256: value.accountBindingEvidenceSha256,
    accountBindingInventorySha256: value.accountBindingInventorySha256,
    transitionSourceManifestSha256: value.transitionSourceManifestSha256,
    phaseSourceManifestSha256: value.phaseSourceManifestSha256,
    artifactInventoryReadbackSha256: value.artifactInventoryReadbackSha256,
    objects: value.objects,
    createdAt: value.createdAt,
  };
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectCode(callback, expectedCode) {
  let caught = null;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe(expectedCode);
}
