import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT,
  RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT,
  describeRingTransitionOperationAnchorContract,
  verifyRingTransitionOperationHeadLocalSeal,
  verifyRingTransitionOperationHeadSet,
} from "../tools/relay_container_ring_transition_operation_anchor_contract.mjs";
import {
  canonicalReceiptBytes,
  sha256ReceiptBytes,
} from "../tools/relay_container_ring_transition_receipt_contract.mjs";

const CLI = path.resolve(
  "tools/verify_relay_container_ring_transition_operation_anchor.mjs",
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ring-transition operation head local seal verifier", () => {
  test("describes a supplied-document, non-authorizing boundary", () => {
    const description = describeRingTransitionOperationAnchorContract();
    expect(description).toMatchObject({
      headSetContract: RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT,
      localSealContract:
        RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT,
      verificationScope: "supplied_operation_anchor_documents",
      maximumCapacityReservations: 128,
      constraints: {
        suppliedHeadSetStructureVerified: true,
        suppliedLocalSealBindingVerified: true,
        suppliedTerminalCandidateOperationBindingEnforced: true,
        executionChainVerified: false,
        operationContextPreimageVerified: false,
        operationReceiptHeadsVerified: false,
        capacityMarkerFilesystemCompletenessVerified: false,
        terminalSnapshotCandidateContentVerified: false,
        localFilesystemCompletenessVerified: false,
        detachedSignatureVerified: false,
        wormStorageVerified: false,
        externalAnchored: false,
        networkRequestsPerformed: false,
        filesWritten: false,
        remoteMutationAuthorized: false,
      },
    });
    expect(
      "aggregateCapacityVerifiedFromSuppliedHeadSet" in
        description.constraints,
    ).toBe(false);
    expect(
      "localSealBindingVerifiedFromSuppliedDocuments" in
        description.constraints,
    ).toBe(false);
  });

  test("verifies a valid zero-operation closure", () => {
    const fixture = closureFixture([]);
    const headSetVerification = verifyRingTransitionOperationHeadSet(
      fixture.headSetBytes,
    );
    expect(headSetVerification).toMatchObject({
      verificationScope: "supplied_operation_head_set_document",
      suppliedHeadSetStructureVerified: true,
      suppliedLocalSealBindingVerified: false,
      suppliedTerminalCandidateOperationBindingVerified: false,
      executionChainVerified: false,
      operationContextPreimageVerified: false,
      operationReceiptHeadsVerified: false,
      capacityMarkerFilesystemCompletenessVerified: false,
      terminalSnapshotCandidateContentVerified: false,
      localFilesystemCompletenessVerified: false,
      operationCount: 0,
      capacityReservationCount: 0,
      markerOnlyCount: 0,
    });
    expect("aggregateCapacityVerified" in headSetVerification).toBe(false);
    expect("localSealBindingVerified" in headSetVerification).toBe(false);
    expect(headSetVerification.headSetBytes).toBe(568);
    expect(headSetVerification.headSetSha256).toBe(
      "5c70cdf03cfdc9f00878b20bffe3e4e790dedbb593bef4c5929713d33a601564",
    );
    const localSealVerification =
      verifyRingTransitionOperationHeadLocalSeal(fixture);
    expect(localSealVerification).toMatchObject({
      verificationScope: "supplied_operation_anchor_documents",
      suppliedHeadSetStructureVerified: true,
      suppliedLocalSealBindingVerified: true,
      suppliedTerminalCandidateOperationBindingVerified: false,
      executionChainVerified: false,
      operationContextPreimageVerified: false,
      operationReceiptHeadsVerified: false,
      capacityMarkerFilesystemCompletenessVerified: false,
      terminalSnapshotCandidateContentVerified: false,
      localFilesystemCompletenessVerified: false,
      externalAnchored: false,
      terminalStatus: "completed",
      terminalStateVersion: 6,
      executionReceiptCount: 8,
      operationCount: 0,
      capacityReservationCount: 0,
      markerOnlyCount: 0,
      terminalSnapshotCandidateSha256: null,
      terminalSnapshotCandidateBytes: null,
      terminalCandidateOperationIdSha256: null,
      terminalCandidateStartReceiptSha256: null,
    });
    expect("aggregateCapacityVerified" in localSealVerification).toBe(false);
    expect("localSealBindingVerified" in localSealVerification).toBe(false);
    expect(localSealVerification.localSealBytes).toBe(1000);
    expect(localSealVerification.localSealSha256).toBe(
      "5875614a4d23597ccf6406c013a8aaab99f9f3cb762d2c793ad4ab7b89fbe9b3",
    );
  });

  test("verifies terminal and marker-only entries", () => {
    const terminal = closureFixture([terminalEntry(3)]);
    expect(
      verifyRingTransitionOperationHeadLocalSeal(terminal),
    ).toMatchObject({
      operationCount: 1,
      capacityReservationCount: 1,
      markerOnlyCount: 0,
    });

    const markerOnly = closureFixture([markerOnlyEntry(7)]);
    expect(
      verifyRingTransitionOperationHeadLocalSeal(markerOnly),
    ).toMatchObject({
      operationCount: 0,
      capacityReservationCount: 1,
      markerOnlyCount: 1,
    });

    const mixed = closureFixture([
      terminalEntry(3),
      markerOnlyEntry(7),
    ]);
    expect(
      verifyRingTransitionOperationHeadLocalSeal(mixed),
    ).toMatchObject({
      operationCount: 1,
      capacityReservationCount: 2,
      markerOnlyCount: 1,
    });
  });

  test("rejects head-set and local-seal SHA or identity tampering", () => {
    {
      const fixture = closureFixture([terminalEntry(3)]);
      fixture.localSeal.operationHeadSetSha256 = "f".repeat(64);
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/head set SHA-256 mismatch/);
    }

    {
      const fixture = closureFixture([terminalEntry(3)]);
      fixture.localSeal.claimDigestSha256 = "f".repeat(64);
      fixture.localSeal.operationHeadSetSha256 =
        sha256ReceiptBytes(fixture.headSetBytes);
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/claimDigestSha256 does not match/);
    }

    {
      const fixture = closureFixture([terminalEntry(3)]);
      fixture.localSeal.operationHeadSetBytes += 1;
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/head set byte length mismatch/);
    }
  });

  test("rejects omission and aggregate count drift", () => {
    {
      const fixture = closureFixture([
        terminalEntry(3),
        markerOnlyEntry(7),
      ]);
      fixture.headSet.entries.pop();
      expect(() =>
        verifyRingTransitionOperationHeadSet(
          canonicalReceiptBytes(fixture.headSet),
        ),
      ).toThrow(/aggregate counts are inconsistent/);
    }

    for (const field of [
      "operationCount",
      "capacityReservationCount",
      "markerOnlyCount",
    ]) {
      const fixture = closureFixture([
        terminalEntry(3),
        markerOnlyEntry(7),
      ]);
      fixture.headSet[field] += 1;
      expect(() =>
        verifyRingTransitionOperationHeadSet(
          canonicalReceiptBytes(fixture.headSet),
        ),
      ).toThrow(/counts are inconsistent/);
    }
  });

  test("rejects slot order, duplicate IDs, and inconsistent chain states", () => {
    {
      const fixture = closureFixture([
        terminalEntry(7),
        markerOnlyEntry(3),
      ]);
      expect(() =>
        verifyRingTransitionOperationHeadSet(fixture.headSetBytes),
      ).toThrow(/strictly slot-sorted/);
    }

    {
      const first = terminalEntry(3);
      const second = markerOnlyEntry(7);
      second.operationIdSha256 = first.operationIdSha256;
      const fixture = closureFixture([first, second]);
      expect(() =>
        verifyRingTransitionOperationHeadSet(fixture.headSetBytes),
      ).toThrow(/operation IDs must be unique/);
    }

    {
      const entry = markerOnlyEntry(3);
      entry.headSha256 = "a".repeat(64);
      const fixture = closureFixture([entry]);
      expect(() =>
        verifyRingTransitionOperationHeadSet(fixture.headSetBytes),
      ).toThrow(/headSha256 must equal null/);
    }

    {
      const entry = terminalEntry(3);
      entry.receiptCount = 1;
      const fixture = closureFixture([entry]);
      expect(() =>
        verifyRingTransitionOperationHeadSet(fixture.headSetBytes),
      ).toThrow(/receiptCount must equal 2/);
    }
  });

  test("rejects noncanonical and unknown fields", () => {
    {
      const fixture = closureFixture([terminalEntry(3)]);
      const noncanonical = new TextEncoder().encode(
        `${JSON.stringify(fixture.headSet, null, 2)}\n`,
      );
      expect(() =>
        verifyRingTransitionOperationHeadSet(noncanonical),
      ).toThrow(/not canonical/);
    }

    {
      const fixture = closureFixture([terminalEntry(3)]);
      fixture.headSet.unexpected = true;
      expect(() =>
        verifyRingTransitionOperationHeadSet(
          canonicalReceiptBytes(fixture.headSet),
        ),
      ).toThrow(/unknown field unexpected/);
    }

    {
      const fixture = closureFixture([terminalEntry(3)]);
      fixture.headSet.entries[0].unexpected = true;
      expect(() =>
        verifyRingTransitionOperationHeadSet(
          canonicalReceiptBytes(fixture.headSet),
        ),
      ).toThrow(/unknown field unexpected/);
    }

    {
      const fixture = closureFixture([terminalEntry(3)]);
      fixture.localSeal.unexpected = true;
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/unknown field unexpected/);
    }

    {
      const fixture = closureFixture([]);
      delete fixture.localSeal.terminalSnapshotCandidateSha256;
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/missing field terminalSnapshotCandidateSha256/);
    }
  });

  test("rejects terminal metadata drift", () => {
    {
      const fixture = closureFixture([]);
      fixture.localSeal.terminalStatus = "completed";
      fixture.localSeal.terminalStateVersion = 5;
      fixture.localSeal.executionReceiptCount = 7;
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/terminal status and state version are inconsistent/);
    }

    {
      const fixture = closureFixture([]);
      fixture.localSeal.executionReceiptCount = 7;
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/execution receipt count is inconsistent/);
    }
  });

  test("validates terminal snapshot candidate metadata without proving its content", () => {
    const fixture = closureFixture([terminalEntry(3)]);
    fixture.localSeal.terminalSnapshotCandidateSha256 = "8".repeat(64);
    fixture.localSeal.terminalSnapshotCandidateBytes = 4096;
    fixture.localSeal.terminalCandidateOperationIdSha256 = operationId(3);
    fixture.localSeal.terminalCandidateStartReceiptSha256 = "6".repeat(64);

    expect(
      verifyRingTransitionOperationHeadLocalSeal({
        headSetBytes: fixture.headSetBytes,
        localSealBytes: canonicalReceiptBytes(fixture.localSeal),
      }),
    ).toMatchObject({
      suppliedLocalSealBindingVerified: true,
      suppliedTerminalCandidateOperationBindingVerified: true,
      terminalSnapshotCandidateContentVerified: false,
      terminalSnapshotCandidateSha256: "8".repeat(64),
      terminalSnapshotCandidateBytes: 4096,
      terminalCandidateOperationIdSha256: operationId(3),
      terminalCandidateStartReceiptSha256: "6".repeat(64),
    });
  });

  test("rejects invalid supplied terminal candidate operation bindings", () => {
    for (const [fixture, expected] of [
      [
        closureFixture([]),
        /terminal candidate operation is missing from supplied head set/,
      ],
      [
        closureFixture([markerOnlyEntry(3)]),
        /must reference a terminal supplied entry/,
      ],
      [
        closureFixture([
          {
            ...terminalEntry(3),
            outcome: "rejected",
          },
        ]),
        /must reference an accepted supplied entry/,
      ],
      [
        closureFixture([terminalEntry(3)]),
        /terminal candidate start receipt does not match supplied entry/,
      ],
    ]) {
      fixture.localSeal.terminalSnapshotCandidateSha256 = "8".repeat(64);
      fixture.localSeal.terminalSnapshotCandidateBytes = 4096;
      fixture.localSeal.terminalCandidateOperationIdSha256 = operationId(3);
      fixture.localSeal.terminalCandidateStartReceiptSha256 = "a".repeat(64);
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(expected);
    }
  });

  test("rejects partial or invalid terminal snapshot candidate metadata", () => {
    {
      const fixture = closureFixture([]);
      fixture.localSeal.terminalSnapshotCandidateSha256 = "8".repeat(64);
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow(/must be all null or all non-null/);
    }

    for (const [field, value] of [
      ["terminalSnapshotCandidateBytes", 0],
      ["terminalSnapshotCandidateBytes", 320 * 1024 + 1],
      ["terminalSnapshotCandidateSha256", "A".repeat(64)],
      ["terminalCandidateOperationIdSha256", "not-a-sha256"],
      ["terminalCandidateStartReceiptSha256", "b".repeat(63)],
    ]) {
      const fixture = closureFixture([]);
      fixture.localSeal.terminalSnapshotCandidateSha256 = "8".repeat(64);
      fixture.localSeal.terminalSnapshotCandidateBytes = 4096;
      fixture.localSeal.terminalCandidateOperationIdSha256 = "9".repeat(64);
      fixture.localSeal.terminalCandidateStartReceiptSha256 = "a".repeat(64);
      fixture.localSeal[field] = value;
      expect(() =>
        verifyRingTransitionOperationHeadLocalSeal({
          headSetBytes: fixture.headSetBytes,
          localSealBytes: canonicalReceiptBytes(fixture.localSeal),
        }),
      ).toThrow();
    }
  });

  test("CLI reads two canonical files and emits JSON", async () => {
    const fixture = closureFixture([
      terminalEntry(3),
      markerOnlyEntry(7),
    ]);
    const directory = await temporaryDirectory();
    const headSetPath = path.join(directory, "operation-head-set.json");
    const localSealPath = path.join(
      directory,
      "operation-head-local-seal.json",
    );
    await writeFile(headSetPath, fixture.headSetBytes);
    await writeFile(localSealPath, fixture.localSealBytes);

    const verified = await runCli([
      "--head-set",
      headSetPath,
      "--local-seal",
      localSealPath,
    ]);
    expect(verified.exitCode).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      verificationScope: "supplied_operation_anchor_documents",
      suppliedHeadSetStructureVerified: true,
      suppliedLocalSealBindingVerified: true,
      suppliedTerminalCandidateOperationBindingVerified: false,
      executionChainVerified: false,
      operationContextPreimageVerified: false,
      operationReceiptHeadsVerified: false,
      capacityMarkerFilesystemCompletenessVerified: false,
      terminalSnapshotCandidateContentVerified: false,
      localFilesystemCompletenessVerified: false,
      operationCount: 1,
      markerOnlyCount: 1,
      detachedSignatureVerified: false,
      wormStorageVerified: false,
      externalAnchored: false,
    });

    const described = await runCli(["--describe"]);
    expect(described.exitCode).toBe(0);
    expect(JSON.parse(described.stdout)).toMatchObject({
      verificationScope: "supplied_operation_anchor_documents",
      constraints: {
        suppliedHeadSetStructureVerified: true,
        suppliedLocalSealBindingVerified: true,
        suppliedTerminalCandidateOperationBindingEnforced: true,
        executionChainVerified: false,
        operationContextPreimageVerified: false,
        operationReceiptHeadsVerified: false,
        capacityMarkerFilesystemCompletenessVerified: false,
        terminalSnapshotCandidateContentVerified: false,
        localFilesystemCompletenessVerified: false,
      },
    });
  });
});

function closureFixture(entries) {
  const headSet = {
    schemaVersion: 1,
    contract: RING_TRANSITION_OPERATION_HEAD_SET_CONTRACT,
    environment: "staging",
    activationSha256: "1".repeat(64),
    authorizationIdSha256: "2".repeat(64),
    claimDigestSha256: "3".repeat(64),
    operationContextSha256: "4".repeat(64),
    capacityLimit: 128,
    operationCount: entries.filter(
      (entry) => entry.chainState === "terminal",
    ).length,
    capacityReservationCount: entries.length,
    markerOnlyCount: entries.filter(
      (entry) => entry.chainState === "marker_only",
    ).length,
    entries: structuredClone(entries),
  };
  const headSetBytes = canonicalReceiptBytes(headSet);
  const localSeal = {
    schemaVersion: 1,
    contract: RING_TRANSITION_OPERATION_HEAD_LOCAL_SEAL_CONTRACT,
    environment: "staging",
    activationSha256: headSet.activationSha256,
    authorizationIdSha256: headSet.authorizationIdSha256,
    claimDigestSha256: headSet.claimDigestSha256,
    operationContextSha256: headSet.operationContextSha256,
    executionReceiptHeadSha256: "5".repeat(64),
    executionReceiptCount: 8,
    terminalStatus: "completed",
    terminalStateVersion: 6,
    operationHeadSetSha256: sha256ReceiptBytes(headSetBytes),
    operationHeadSetBytes: headSetBytes.byteLength,
    operationCount: headSet.operationCount,
    capacityReservationCount: headSet.capacityReservationCount,
    markerOnlyCount: headSet.markerOnlyCount,
    terminalSnapshotCandidateSha256: null,
    terminalSnapshotCandidateBytes: null,
    terminalCandidateOperationIdSha256: null,
    terminalCandidateStartReceiptSha256: null,
  };
  return {
    headSet,
    localSeal,
    headSetBytes,
    localSealBytes: canonicalReceiptBytes(localSeal),
  };
}

function terminalEntry(slot) {
  return {
    slot,
    operationIdSha256: operationId(slot),
    chainState: "terminal",
    startReceiptSha256: "6".repeat(64),
    receiptCount: 2,
    headSha256: "7".repeat(64),
    outcome: "accepted",
  };
}

function markerOnlyEntry(slot) {
  return {
    slot,
    operationIdSha256: operationId(slot),
    chainState: "marker_only",
    startReceiptSha256: null,
    receiptCount: 0,
    headSha256: null,
    outcome: null,
  };
}

function operationId(slot) {
  return slot.toString(16).padStart(64, "0");
}

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cinatoken-operation-anchor-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(arguments_) {
  const child = Bun.spawn(["bun", CLI, ...arguments_], {
    cwd: path.resolve("."),
    env: {
      PATH: process.env.PATH ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
