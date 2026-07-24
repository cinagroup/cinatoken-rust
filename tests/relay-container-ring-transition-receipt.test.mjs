import { describe, expect, test } from "bun:test";

import {
  MAX_RING_TRANSITION_RECEIPT_BYTES,
  MAX_RING_TRANSITION_RECEIPTS_PER_CHAIN,
  canonicalReceiptBytes,
  computeRingTransitionExpiryDigest,
  computeRingTransitionStepDigest,
  describeRingTransitionExecutionReceiptContract,
  sha256ReceiptBytes,
  verifyRingTransitionExecutionReceiptChain,
  verifyRingTransitionExecutionReceiptPrefix,
} from "../tools/relay_container_ring_transition_receipt_contract.mjs";

const H = Object.freeze({
  authorization: "1".repeat(64),
  claim: "2".repeat(64),
  ledger: "3".repeat(64),
  owner: "4".repeat(64),
  account: "5".repeat(64),
  readCredential: "6".repeat(64),
  claimCredential: "7".repeat(64),
  deployCredential: "8".repeat(64),
  accessClient: "9".repeat(64),
  permitSpki: "a".repeat(64),
  trust: "b".repeat(64),
  artifact: "c".repeat(64),
  releaseManifest: "d".repeat(64),
  releasePacket: "e".repeat(64),
  releasePolicy: "f".repeat(64),
  inventory: "0".repeat(64),
  publicationManifest: "12".repeat(32),
  publicationPacket: "23".repeat(32),
  generation: "34".repeat(32),
  snapshot: "45".repeat(32),
  history: "56".repeat(32),
});

describe("K7 ring-transition Execution Receipt V1 replay verifier", () => {
  test("is a credential-free, non-authorizing, in-memory verifier", () => {
    expect(describeRingTransitionExecutionReceiptContract()).toEqual({
      ok: true,
      schemaVersion: 1,
      contract: "cinatoken-ring-transition-runner-execution-receipt-v1",
      environment: "staging",
      maximumReceiptBytes: 65_536,
      maximumReceiptsPerChain: 128,
      constraints: {
        canonicalJsonRequired: true,
        duplicateAndUnknownFieldsAllowed: false,
        predecessorSha256Required: true,
        sharedIdentityRequired: true,
        monotonicRecordedAtRequired: true,
        terminalSealRequired: true,
        unsealedPrefixVerificationSupported: true,
        credentialsRead: false,
        networkRequestsPerformed: false,
        filesWritten: false,
        remoteMutationAuthorized: false,
      },
    });
  });

  test("matches the deterministic two-record prefix vector and exact chain", () => {
    const { bytes } = deterministicTwoRecordChain();
    expect(bytes.slice(0, 2).map(sha256ReceiptBytes)).toEqual([
      "01dcd416f65dbe5b7a75fd6a400f077533deafcf1d62d992f2b24a9b59e24988",
      "8f7af8bad7a6af442d4fd4301bdd84af8a465cdb1bc604e544f265a705c65f4b",
    ]);
    expect(verifyRingTransitionExecutionReceiptChain(bytes)).toEqual({
      ok: true,
      authorizationIdSha256: H.authorization,
      receiptCount: 3,
      headSha256:
        "749caa2c9591265ef0bc93381fb6d03c191621479cbd84c1806c881b4f022565",
      sealed: true,
    });
    expect(
      verifyRingTransitionExecutionReceiptChain(
        bytes.map((receipt) => Array.from(receipt)),
      ),
    ).toMatchObject({
      receiptCount: 3,
      headSha256:
        "749caa2c9591265ef0bc93381fb6d03c191621479cbd84c1806c881b4f022565",
    });
  });

  test("independently verifies claimed and T1 prefixes without treating them as terminal", () => {
    const terminalBytes = deterministicTwoRecordChain().bytes;
    const t1Prefix = controllerRecoveryExpiryChain().bytes.slice(0, 2);
    expect(
      verifyRingTransitionExecutionReceiptPrefix(terminalBytes.slice(0, 1)),
    ).toEqual({
      ok: true,
      authorizationIdSha256: H.authorization,
      receiptCount: 1,
      headSha256:
        "01dcd416f65dbe5b7a75fd6a400f077533deafcf1d62d992f2b24a9b59e24988",
      sealed: false,
    });
    expect(verifyRingTransitionExecutionReceiptPrefix(t1Prefix)).toEqual({
      ok: true,
      authorizationIdSha256: H.authorization,
      receiptCount: 2,
      headSha256:
        "058f4e27874bbab0243a81178ba41187cc981c43de43fce2fc70ec5a5667a1c5",
      sealed: false,
    });
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(t1Prefix),
    ).toThrow(/terminal seal is missing/);
    expect(() =>
      verifyRingTransitionExecutionReceiptPrefix(terminalBytes.slice(0, 2)),
    ).toThrow(/terminal seal is missing/);
  });

  test("rejects predecessor drift", () => {
    const { records } = deterministicTwoRecordChain();
    records[1].predecessorReceiptSha256 = "f".repeat(64);
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(records.map(canonicalReceiptBytes)),
    ).toThrow(/predecessor SHA-256 mismatch/);
  });

  test("rejects sequence gaps and records after a terminal seal", () => {
    const { records } = deterministicTwoRecordChain();
    records[1].sequence = 3;
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(records.map(canonicalReceiptBytes)),
    ).toThrow(/sequence gap/);

    const linked = linkRecords([
      ...deterministicTwoRecordChain().records,
      authorityStepReceipt(),
    ]);
    expect(() => verifyRingTransitionExecutionReceiptChain(linked)).toThrow(
      /terminal seal must be the final receipt|after terminal seal/,
    );
  });

  test("rejects unknown and duplicate fields", () => {
    const { records } = deterministicTwoRecordChain();
    records[0].unexpected = true;
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(records.map(canonicalReceiptBytes)),
    ).toThrow(/unknown field unexpected/);

    const valid = deterministicTwoRecordChain().bytes[0];
    const duplicate = new TextEncoder().encode(
      `${new TextDecoder().decode(valid).slice(0, -1)},"schemaVersion":1}`,
    );
    expect(() =>
      verifyRingTransitionExecutionReceiptChain([
        duplicate,
        deterministicTwoRecordChain().bytes[1],
      ]),
    ).toThrow(/duplicate fields/);
  });

  test("rejects non-canonical JSON", () => {
    const { bytes } = deterministicTwoRecordChain();
    const nonCanonical = new Uint8Array(bytes[0].length + 1);
    nonCanonical.set(bytes[0]);
    nonCanonical[nonCanonical.length - 1] = 0x0a;
    expect(() =>
      verifyRingTransitionExecutionReceiptChain([
        nonCanonical,
        bytes[1],
      ]),
    ).toThrow(/not canonical/);
  });

  test("rejects secret-like forbidden fields", () => {
    const { records } = deterministicTwoRecordChain();
    records[0].event.apiToken = "fixture-value";
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(records.map(canonicalReceiptBytes)),
    ).toThrow(/forbidden secret-like field apiToken/);
  });

  test("rejects shared identity drift and non-monotonic time", () => {
    for (const mutate of [
      (receipt) => {
        receipt.release.sourceCommit = "c".repeat(40);
      },
      (receipt) => {
        receipt.credentialIdentity.authorityVersionId = "different";
      },
      (receipt) => {
        receipt.claim.claimedAt += 1;
      },
    ]) {
      const { records } = deterministicTwoRecordChain();
      mutate(records[1]);
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/shared release, credential, or claim identity drift/);
    }

    const { records } = deterministicTwoRecordChain();
    records[2].recordedAt = records[1].recordedAt - 1;
    records[2].event.terminalAt = records[2].recordedAt;
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
    ).toThrow(/recordedAt is not monotonic/);
  });

  test("rejects terminal chainLength drift and configured size limits", () => {
    const { records } = deterministicTwoRecordChain();
    records[2].event.chainLength = 4;
    expect(() =>
      verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
    ).toThrow(/chainLength mismatch/);

    const oversized = new Uint8Array(MAX_RING_TRANSITION_RECEIPT_BYTES + 1);
    expect(() =>
      verifyRingTransitionExecutionReceiptChain([
        oversized,
        deterministicTwoRecordChain().bytes[1],
      ]),
    ).toThrow(/byte length/);

    expect(() =>
      verifyRingTransitionExecutionReceiptChain(
        Array.from(
          { length: MAX_RING_TRANSITION_RECEIPTS_PER_CHAIN + 1 },
          () => new Uint8Array([0x7b, 0x7d]),
        ),
      ),
    ).toThrow(/receipt count/);
  });

  test("rejects authority step digest, actor, shape, and expiry-boundary drift", () => {
    {
      const { records } = deterministicTwoRecordChain();
      records[1].event.step.stepDigestSha256 = "f".repeat(64);
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/authority step digest mismatch/);
    }

    {
      const { records } = deterministicTwoRecordChain();
      records[1].event.step.actorExecutionIdSha256 = "f".repeat(64);
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/step actor does not own the claim/);
    }

    {
      const { records } = deterministicTwoRecordChain();
      records[1].event.step.toStatus = "completed";
      refreshStepDigest(records[1]);
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/authority step shape is invalid/);
    }

    {
      const { records } = deterministicTwoRecordChain();
      records[1].recordedAt = records[1].claim.expiresAt;
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/non-inflight authority step was recorded after expiry/);
    }
  });

  test("accepts direct expiry and controller recovery expiry chains", () => {
    const direct = directExpiryChain();
    expect(verifyRingTransitionExecutionReceiptChain(direct.bytes)).toMatchObject({
      receiptCount: 3,
      sealed: true,
    });

    const recovery = controllerRecoveryExpiryChain();
    expect(
      verifyRingTransitionExecutionReceiptChain(recovery.bytes),
    ).toMatchObject({
      receiptCount: 6,
      sealed: true,
    });
  });

  test("rejects recovery expiry digest, actor, path, and early timestamp drift", () => {
    {
      const { records } = controllerRecoveryExpiryChain();
      records[4].event.expiry.expiryEventDigestSha256 = "f".repeat(64);
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/authority expiry digest mismatch/);
    }

    {
      const { records } = controllerRecoveryExpiryChain();
      records[4].event.expiry.authorityActorIdSha256 =
        records[4].claim.claimOwnerSha256;
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/expiry actor must be independent/);
    }

    {
      const { records } = controllerRecoveryExpiryChain();
      records[4].event.expiry.toStatus = "expired";
      refreshExpiryDigest(records[4]);
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/authority expiry shape is invalid/);
    }

    {
      const { records } = controllerRecoveryExpiryChain();
      records[4].recordedAt = records[4].claim.expiresAt - 1;
      expect(() =>
        verifyRingTransitionExecutionReceiptChain(linkRecords(records)),
      ).toThrow(/authority expiry was recorded before expiry/);
    }
  });
});

function deterministicTwoRecordChain() {
  const genesis = baseReceipt({
    sequence: 1,
    predecessorReceiptSha256: null,
    recordedAt: 1_721_760_000,
    event: {
      kind: "claim_observed",
      status: "claimed",
      stateVersion: 0,
    },
  });
  const genesisBytes = canonicalReceiptBytes(genesis);
  const step = authorityStepReceipt();
  step.sequence = 2;
  step.predecessorReceiptSha256 = sha256ReceiptBytes(genesisBytes);
  const terminal = baseReceipt({
    sequence: 3,
    predecessorReceiptSha256: sha256ReceiptBytes(canonicalReceiptBytes(step)),
    recordedAt: 1_721_760_100,
    event: {
      kind: "terminal_seal",
      status: "aborted",
      stateVersion: 1,
      terminalAt: 1_721_760_100,
      finalSnapshotSha256: H.snapshot,
      finalSnapshotBytes: 1_024,
      historySha256: H.history,
      chainLength: 3,
    },
  });
  return {
    records: [genesis, step, terminal],
    bytes: [
      genesisBytes,
      canonicalReceiptBytes(step),
      canonicalReceiptBytes(terminal),
    ],
  };
}

function baseReceipt({
  sequence,
  predecessorReceiptSha256,
  recordedAt,
  event,
}) {
  return {
    schemaVersion: 1,
    contract: "cinatoken-ring-transition-runner-execution-receipt-v1",
    environment: "staging",
    sequence,
    predecessorReceiptSha256,
    recordedAt,
    release: {
      sourceCommit: "a".repeat(40),
      gitTreeSha: "b".repeat(40),
      releaseManifestSha256: H.releaseManifest,
      releasePacketSha256: H.releasePacket,
      releasePolicySha256: H.releasePolicy,
      artifactSha256: H.artifact,
      moduleInventorySha256: H.inventory,
      moduleCount: 23,
      publicationManifestSha256: H.publicationManifest,
      publicationPacketSha256: H.publicationPacket,
      generationSha256: H.generation,
      activationSequence: 1,
      previousPublicationManifestSha256: null,
      publishedAt: "2026-07-23T11:00:00.000Z",
      expiresAt: "2026-07-23T13:00:00.000Z",
    },
    credentialIdentity: {
      accountIdSha256: H.account,
      readCredentialIdSha256: H.readCredential,
      claimCredentialIdSha256: H.claimCredential,
      deployCredentialIdSha256: H.deployCredential,
      accessClientIdSha256: H.accessClient,
      authorityVersionId: "authority-v1",
      permitSpkiSha256: H.permitSpki,
      trustConfigSha256: H.trust,
      runnerBuildSha256: H.artifact,
      controllerServiceName: "cinatoken-controller-staging",
      edgeServiceName: "cinatoken-edge-staging",
      stableReadbackObservationSeconds: 5,
    },
    claim: {
      authorizationIdSha256: H.authorization,
      claimDigestSha256: H.claim,
      ledgerIdentitySha256: H.ledger,
      claimOwnerSha256: H.owner,
      accountIdSha256: H.account,
      generatedAt: 1_721_759_900,
      claimedAt: 1_721_760_000,
      expiresAt: 1_721_763_600,
    },
    event,
  };
}

function authorityStepReceipt() {
  return stepReceipt({
    sequence: 2,
    recordedAt: 1_721_760_050,
    step: {
      stateVersion: 1,
      stepCode: "terminal",
      fromStatus: "claimed",
      toStatus: "aborted",
      actorExecutionIdSha256: H.owner,
      mutationRequestSha256: null,
      cloudflareRequestIdSha256: null,
      deploymentSetSha256: null,
      evidenceSha256: "78".repeat(32),
      failureClass: "operator_abort",
      transportOutcome: "not_applicable",
      stepDigestSha256: "0".repeat(64),
    },
  });
}

function stepReceipt({ sequence, recordedAt, step }) {
  const receipt = baseReceipt({
    sequence,
    predecessorReceiptSha256: null,
    recordedAt,
    event: {
      kind: "authority_step",
      step,
    },
  });
  refreshStepDigest(receipt);
  return receipt;
}

function expiryReceipt({ sequence, recordedAt, expiry }) {
  const receipt = baseReceipt({
    sequence,
    predecessorReceiptSha256: null,
    recordedAt,
    event: {
      kind: "authority_expiry",
      expiry,
    },
  });
  refreshExpiryDigest(receipt);
  return receipt;
}

function terminalReceipt({
  sequence,
  recordedAt,
  status,
  stateVersion,
  chainLength,
}) {
  return baseReceipt({
    sequence,
    predecessorReceiptSha256: null,
    recordedAt,
    event: {
      kind: "terminal_seal",
      status,
      stateVersion,
      terminalAt: recordedAt,
      finalSnapshotSha256: H.snapshot,
      finalSnapshotBytes: 1_024,
      historySha256: H.history,
      chainLength,
    },
  });
}

function directExpiryChain() {
  const genesis = deterministicTwoRecordChain().records[0];
  const expiry = expiryReceipt({
    sequence: 2,
    recordedAt: genesis.claim.expiresAt,
    expiry: {
      stateVersion: 1,
      fromStatus: "claimed",
      toStatus: "expired",
      authorityActorIdSha256: "ab".repeat(32),
      evidenceSha256: "bc".repeat(32),
      expiryEventDigestSha256: "0".repeat(64),
      failureClass: "authorization_expired",
    },
  });
  const terminal = terminalReceipt({
    sequence: 3,
    recordedAt: genesis.claim.expiresAt,
    status: "expired",
    stateVersion: 1,
    chainLength: 3,
  });
  const records = [genesis, expiry, terminal];
  return { records, bytes: linkRecords(records) };
}

function controllerRecoveryExpiryChain() {
  const genesis = deterministicTwoRecordChain().records[0];
  const t1 = stepReceipt({
    sequence: 2,
    recordedAt: genesis.claim.claimedAt + 10,
    step: {
      stateVersion: 1,
      stepCode: "t1_readback",
      fromStatus: "claimed",
      toStatus: "t1_verified",
      actorExecutionIdSha256: H.owner,
      mutationRequestSha256: null,
      cloudflareRequestIdSha256: null,
      deploymentSetSha256: "9a".repeat(32),
      evidenceSha256: "9b".repeat(32),
      failureClass: "",
      transportOutcome: "not_applicable",
      stepDigestSha256: "0".repeat(64),
    },
  });
  const intent = stepReceipt({
    sequence: 3,
    recordedAt: genesis.claim.claimedAt + 20,
    step: {
      stateVersion: 2,
      stepCode: "controller_mutation_intent",
      fromStatus: "t1_verified",
      toStatus: "controller_inflight",
      actorExecutionIdSha256: H.owner,
      mutationRequestSha256: "9c".repeat(32),
      cloudflareRequestIdSha256: null,
      deploymentSetSha256: null,
      evidenceSha256: "9d".repeat(32),
      failureClass: "",
      transportOutcome: "not_applicable",
      stepDigestSha256: "0".repeat(64),
    },
  });
  const post = stepReceipt({
    sequence: 4,
    recordedAt: genesis.claim.expiresAt,
    step: {
      stateVersion: 3,
      stepCode: "controller_post_readback",
      fromStatus: "controller_inflight",
      toStatus: "controller_verified",
      actorExecutionIdSha256: H.owner,
      mutationRequestSha256: "9c".repeat(32),
      cloudflareRequestIdSha256: "9e".repeat(32),
      deploymentSetSha256: "9f".repeat(32),
      evidenceSha256: "a0".repeat(32),
      failureClass: "",
      transportOutcome: "success",
      stepDigestSha256: "0".repeat(64),
    },
  });
  const expiry = expiryReceipt({
    sequence: 5,
    recordedAt: genesis.claim.expiresAt + 1,
    expiry: {
      stateVersion: 4,
      fromStatus: "controller_verified",
      toStatus: "recovery_required",
      authorityActorIdSha256: "ab".repeat(32),
      evidenceSha256: "a1".repeat(32),
      expiryEventDigestSha256: "0".repeat(64),
      failureClass: "authorization_expired",
    },
  });
  const terminal = terminalReceipt({
    sequence: 6,
    recordedAt: genesis.claim.expiresAt + 1,
    status: "recovery_required",
    stateVersion: 4,
    chainLength: 6,
  });
  const records = [genesis, t1, intent, post, expiry, terminal];
  return { records, bytes: linkRecords(records) };
}

function refreshStepDigest(receipt) {
  receipt.event.step.stepDigestSha256 = computeRingTransitionStepDigest({
    claim: receipt.claim,
    step: receipt.event.step,
  });
}

function refreshExpiryDigest(receipt) {
  receipt.event.expiry.expiryEventDigestSha256 =
    computeRingTransitionExpiryDigest({
      claim: receipt.claim,
      expiry: receipt.event.expiry,
    });
}

function linkRecords(records) {
  const bytes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = structuredClone(records[index]);
    record.sequence = index + 1;
    record.predecessorReceiptSha256 =
      index === 0 ? null : sha256ReceiptBytes(bytes[index - 1]);
    bytes.push(canonicalReceiptBytes(record));
  }
  return bytes;
}
