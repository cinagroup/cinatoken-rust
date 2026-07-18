import { afterAll, describe, expect, test } from "bun:test";
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
  MANIFEST_CONTRACT,
  PINNED_GO_HEAD,
  REQUIRED_BATCH_MAPS,
  REQUIRED_EVIDENCE_KINDS,
  REQUIRED_RECONCILIATION_DOMAINS,
  REQUIRED_ROLLBACK_COMPONENTS,
  canonicalJson,
  sha256Hex,
  verifyGoVpsCutoverEvidence,
} from "../tools/go_vps_cutover_evidence_contract.mjs";

const fixedNow = new Date("2026-07-19T10:05:00.000Z");
const freezeAt = "2026-07-19T10:00:00.000Z";
const evidenceCapturedAt = "2026-07-19T10:03:00.000Z";
const generatedAt = "2026-07-19T10:04:00.000Z";
const expiresAt = "2026-07-19T10:20:00.000Z";
const evidenceExpiresAt = "2026-07-19T10:30:00.000Z";
const temporaryRoots = [];

afterAll(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Go/VPS production cutover evidence contract", () => {
  test("accepts one complete redacted packet only for production review", async () => {
    const bundle = await createBundle();
    const result = await verify(bundle);

    expect(result.ok).toBe(true);
    expect(result.decision).toBe("eligible-for-production-cutover-review");
    expect(result.eligibleForProductionCutoverReview).toBe(true);
    expect(result.productionCutoverAuthorized).toBe(false);
    expect(result.goHead).toBe(PINNED_GO_HEAD);
    expect(result.evidenceStatuses).toEqual(
      REQUIRED_EVIDENCE_KINDS.map((kind) => ({ kind, status: "pass" })),
    );
    expect(result.blockers).toEqual([]);
    expect(result.safetyBoundary).toEqual({
      credentialsReadByVerifier: false,
      linePayloadsEmittedByVerifier: false,
      networkRequestsPerformedByVerifier: false,
      productionCutoverAuthorized: false,
      remoteMutationPerformedByVerifier: false,
      shellOrSqlExecutedByVerifier: false,
    });
    expect(JSON.stringify(result)).not.toContain("go-01");
  });

  test("rejects a Go candidate that is not pinned to the required HEAD", async () => {
    const bundle = await createBundle({
      mutateSubject: (subject) => {
        subject.candidate.goHead = "0".repeat(40);
        subject.candidateDigestSha256 = digestObject(subject.candidate);
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/Go HEAD mismatch/);
  });

  test("rejects candidate and cohort digest drift", async () => {
    const candidateDrift = await createBundle({
      mutateSubject: (subject) => {
        subject.candidateDigestSha256 = "f".repeat(64);
      },
    });
    await expect(verify(candidateDrift)).rejects.toThrow(/candidate digest mismatch/);

    const cohortDrift = await createBundle({
      mutateSubject: (subject) => {
        subject.cohortDigestSha256 = "e".repeat(64);
      },
    });
    await expect(verify(cohortDrift)).rejects.toThrow(/cohort digest mismatch/);
  });

  test("rejects path escape references", async () => {
    const bundle = await createBundle({
      mutateRecords: (records) => {
        records[0].path = "../candidate-topology.json";
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/evidence path/);
  });

  test("rejects symbolic-link evidence even when the target is local", async () => {
    const bundle = await createBundle();
    const evidencePath = bundle.evidencePaths.get("candidate-topology");
    if (process.platform === "win32") {
      const targetPath = path.join(path.dirname(evidencePath), "candidate-target");
      await mkdir(targetPath);
      await rm(evidencePath);
      await symlink(targetPath, evidencePath, "junction");
    } else {
      const targetPath = path.join(
        path.dirname(evidencePath),
        "candidate-topology-target.json",
      );
      await rename(evidencePath, targetPath);
      await symlink(path.basename(targetPath), evidencePath, "file");
    }
    await expect(verify(bundle)).rejects.toThrow(/non-symlink|symbolic link/);
  });

  test("rejects evidence digest or byte drift", async () => {
    const bundle = await createBundle({
      afterWrite: async ({ evidencePaths }) => {
        await writeFile(evidencePaths.get("ingress-drain"), "{}\n", "utf8");
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/byte count mismatch|digest mismatch/);
  });

  test("rejects an evidence file above the fixed byte bound", async () => {
    const bundle = await createBundle({
      afterWrite: async ({ evidencePaths }) => {
        await writeFile(
          evidencePaths.get("candidate-topology"),
          Buffer.alloc(512 * 1024 + 1, 0x20),
        );
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/byte bound/);
  });

  test("rejects a missing required evidence reference", async () => {
    const bundle = await createBundle({
      mutateRecords: (records) => records.pop(),
    });
    await expect(verify(bundle)).rejects.toThrow(/every required evidence reference/);
  });

  test("rejects a missing protocol node", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "ingress-drain") delete evidence.facts.protocols.websocket;
      },
    });
    await expect(verify(bundle)).rejects.toThrow(/unknown or missing fields/);
  });

  test("returns not-proven when any protocol has not drained to zero", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "ingress-drain") {
          evidence.facts.protocols.websocket.activeCount = 1;
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "ingress-drain:protocol-not-drained");
  });

  test("returns not-proven when per-process financial state is unknown", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "process-state-drain") {
          evidence.facts.processes[0].billingSessions.status = "unknown";
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(
      result,
      "process-state-drain:billing-sessions-status-not-pass",
    );
  });

  test("returns not-proven when any per-process batch map is non-zero", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "process-state-drain") {
          evidence.facts.processes[1].batchMaps.usage.count = 1;
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "process-state-drain:batch-map-not-zero");
  });

  test("returns not-proven when fewer than two flushes are evidenced", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "persistence-stability") evidence.facts.flushes.pop();
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "persistence-stability:insufficient-flushes");
  });

  test("returns not-proven on SQL or LOG_DB snapshot drift", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "persistence-stability") {
          evidence.facts.logDbSnapshots[1].digestSha256 = "f".repeat(64);
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "persistence-stability:log-db-snapshot-drift");
  });

  test("returns not-proven when a scheduler has duplicate owners", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "scheduler-ownership") {
          evidence.facts.owners[0].ownerCount = 2;
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "scheduler-ownership:scheduler-owner-count-not-one");
  });

  test("returns not-proven on forward lag and reverse conflicts", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "bidirectional-sync") {
          evidence.facts.directions.goToCloudflare.lagRecordCount = 1;
          evidence.facts.directions.cloudflareToGo.conflictCount = 1;
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "bidirectional-sync:sync-lag-not-zero");
    expect(result.blockers).toContain("bidirectional-sync:sync-conflicts-not-zero");
  });

  test("returns not-proven when pending work is neither empty nor fully handed off", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "pending-work") {
          evidence.facts.orders.targetReadbackCount = 1;
        }
      },
    });
    const result = await verify(bundle);
    expectNotProven(result, "pending-work:pending-work-handoff-incomplete");
  });

  test("returns not-proven when the rollback package is incomplete", async () => {
    const bundle = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "rollback-bundle") evidence.facts.components.pop();
      },
    });
    const result = await verify(bundle);
    expectNotProven(
      result,
      "rollback-bundle:rollback-component-inventory-incomplete",
    );
  });

  test("accepts the status vocabulary but blocks unknown and not-applicable", async () => {
    const failed = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "ingress-drain") evidence.status = "fail";
      },
    });
    expectNotProven(await verify(failed), "ingress-drain:declared-fail");

    const unknown = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "scheduler-ownership") evidence.status = "unknown";
      },
    });
    expectNotProven(
      await verify(unknown),
      "scheduler-ownership:declared-unknown",
    );

    const notApplicable = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "pending-work") evidence.status = "not-applicable";
      },
    });
    expectNotProven(
      await verify(notApplicable),
      "pending-work:declared-not-applicable",
    );

    const invalid = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "pending-work") evidence.status = "maybe";
      },
    });
    await expect(verify(invalid)).rejects.toThrow(/status is invalid/);
  });

  test("rejects payload and secret fields before facts are trusted", async () => {
    const payload = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "candidate-topology") evidence.payload = { line: "raw" };
      },
    });
    await expect(verify(payload)).rejects.toThrow(/prohibited field/);

    const secret = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "candidate-topology") evidence.secretValue = "do-not-print";
      },
    });
    await expect(verify(secret)).rejects.toThrow(/prohibited field/);

    const credentialShaped = await createBundle({
      mutateEvidence: (kind, evidence) => {
        if (kind === "candidate-topology") {
          evidence.collector.collectorId = "sk-abcdefghijklmnopqrstuvwx";
        }
      },
    });
    await expect(verify(credentialShaped)).rejects.toThrow(/credential-shaped/);
  });

  test("rejects stale and future timestamps", async () => {
    const stale = await createBundle({
      mutateSubject: (subject) => {
        subject.cohort.freezeAt = "2026-07-19T03:59:00.000Z";
        subject.cohortDigestSha256 = digestObject(subject.cohort);
      },
    });
    await expect(verify(stale)).rejects.toThrow(/stale/);

    const future = await createBundle({
      mutateSubject: (subject) => {
        subject.generatedAt = "2026-07-19T10:06:01.000Z";
        subject.expiresAt = "2026-07-19T10:20:00.000Z";
      },
    });
    await expect(verify(future)).rejects.toThrow(/future/);
  });

  test("rejects noncanonical JSON and unsafe integers", async () => {
    const noncanonical = await createBundle();
    const manifest = JSON.parse(await readFile(noncanonical.manifestPath, "utf8"));
    await writeFile(
      noncanonical.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await expect(verify(noncanonical)).rejects.toThrow(/canonical JSON/);

    const unsafe = await createBundle();
    await writeFile(
      unsafe.manifestPath,
      (await readFile(unsafe.manifestPath, "utf8")).replace(
        '"schemaVersion":1',
        '"schemaVersion":9007199254740992',
      ),
      "utf8",
    );
    await expect(verify(unsafe)).rejects.toThrow(/safe integers/);
  });

  test("the verifier modules contain no execution, network, SQL, or env-value reader", async () => {
    const sources = await Promise.all([
      readFile(
        path.join(import.meta.dir, "../tools/go_vps_cutover_evidence_contract.mjs"),
        "utf8",
      ),
      readFile(
        path.join(import.meta.dir, "../tools/verify_go_vps_cutover_evidence.mjs"),
        "utf8",
      ),
    ]);
    const source = sources.join("\n");
    expect(source).not.toMatch(/node:child_process|process\.env|\bfetch\s*\(|\beval\s*\(/);
    expect(source).not.toMatch(/inspect-source|wrangler|sqlite|\bSELECT\b|\bINSERT\b/);
  });
});

function expectNotProven(result, blocker) {
  expect(result.ok).toBe(false);
  expect(result.decision).toBe("not-proven");
  expect(result.productionCutoverAuthorized).toBe(false);
  expect(result.blockers).toContain(blocker);
}

async function verify(bundle, now = fixedNow) {
  return verifyGoVpsCutoverEvidence({ manifestPath: bundle.manifestPath, now });
}

async function createBundle({
  mutateEvidence = () => {},
  mutateRecords = () => {},
  mutateSubject = () => {},
  mutateManifest = () => {},
  afterWrite = async () => {},
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "go-vps-cutover-evidence-"));
  temporaryRoots.push(root);
  const evidenceDirectory = path.join(root, "evidence");
  await mkdir(evidenceDirectory);

  const candidate = createCandidate();
  const cohort = createCohort();
  const candidateDigestSha256 = digestObject(candidate);
  const cohortDigestSha256 = digestObject(cohort);
  const records = [];
  const evidencePaths = new Map();

  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    const evidence = {
      schemaVersion: 1,
      contract: EVIDENCE_CONTRACT,
      kind,
      status: "pass",
      candidateDigestSha256,
      cohortDigestSha256,
      capturedAt: evidenceCapturedAt,
      expiresAt: evidenceExpiresAt,
      collector: {
        collectorId: `redacted-${kind}`,
        collectorVersion: "1.0.0",
        sourceArtifactSha256: sha256Hex(Buffer.from(`collector:${kind}`, "utf8")),
      },
      facts: createFacts(kind, candidate, cohort),
    };
    mutateEvidence(kind, evidence);
    const evidencePath = path.join(evidenceDirectory, `${kind}.json`);
    const bytes = Buffer.from(`${canonicalJson(evidence)}\n`, "utf8");
    await writeFile(evidencePath, bytes);
    evidencePaths.set(kind, evidencePath);
    records.push({
      kind,
      path: `evidence/${kind}.json`,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      capturedAt: evidence.capturedAt,
      expiresAt: evidence.expiresAt,
    });
  }

  mutateRecords(records);
  const subject = {
    candidate,
    candidateDigestSha256,
    cohort,
    cohortDigestSha256,
    decisionRequested: "production-cutover-review",
    evidence: records,
    expiresAt,
    generatedAt,
  };
  mutateSubject(subject);
  const manifest = {
    schemaVersion: 1,
    contract: MANIFEST_CONTRACT,
    subject,
    subjectDigestSha256: digestObject(subject),
  };
  mutateManifest(manifest);
  const manifestPath = path.join(root, "manifest.json");
  await writeCanonical(manifestPath, manifest);
  await afterWrite({ root, manifestPath, evidencePaths });
  return { root, manifestPath, evidencePaths };
}

function createCandidate() {
  return {
    repository: "cinagroup/cinatoken-rust",
    rustCommitSha: "1".repeat(40),
    goRepository: "cinagroup/cinatoken",
    goHead: PINNED_GO_HEAD,
    goArtifactDigestSha256: digestText("go-artifact"),
    goDeploymentDigestSha256: digestText("go-deployment"),
    cloudflareDeploymentDigestSha256: digestText("cloudflare-deployment"),
    sqlDatabaseIdentitySha256: digestText("sql-database-identity"),
    logDatabaseIdentitySha256: digestText("log-database-identity"),
    redisIdentitySha256: digestText("redis-identity"),
    loadBalancerIdentitySha256: digestText("load-balancer-identity"),
  };
}

function createCohort() {
  return {
    cutoverId: "prod-2026-07-19-a",
    kind: "full-production",
    environment: "production",
    sourceAuthority: "go-vps",
    targetAuthority: "cloudflare",
    freezeAt,
    goProcessIds: ["go-01", "go-02"],
    schedulerIds: [
      "batch-flush",
      "billing-export",
      "order-sync",
      "task-poll",
    ],
    trafficScopeSha256: digestText("all-production-traffic"),
    dataScopeSha256: digestText("all-production-data"),
  };
}

function createFacts(kind, candidate, cohort) {
  switch (kind) {
    case "candidate-topology":
      return {
        inventoryStatus: "pass",
        goHead: candidate.goHead,
        goArtifactDigestSha256: candidate.goArtifactDigestSha256,
        goDeploymentDigestSha256: candidate.goDeploymentDigestSha256,
        cloudflareDeploymentDigestSha256:
          candidate.cloudflareDeploymentDigestSha256,
        sqlDatabaseIdentitySha256: candidate.sqlDatabaseIdentitySha256,
        logDatabaseIdentitySha256: candidate.logDatabaseIdentitySha256,
        redisIdentitySha256: candidate.redisIdentitySha256,
        loadBalancerIdentitySha256: candidate.loadBalancerIdentitySha256,
        authorityOwnerCount: 1,
        unknownProcessCount: 0,
        schedulerIds: [...cohort.schedulerIds],
        goProcesses: cohort.goProcessIds.map((processId, index) => ({
          processId,
          role: index === 0 ? "master" : "replica",
          status: "pass",
          artifactDigestSha256: candidate.goArtifactDigestSha256,
          observedAt: "2026-07-19T10:00:10.000Z",
        })),
      };
    case "ingress-drain":
      return {
        lastAcceptedAt: "2026-07-19T10:00:30.000Z",
        drainStartedAt: "2026-07-19T10:00:31.000Z",
        observationEndedAt: "2026-07-19T10:01:31.000Z",
        loadBalancerOpenConnections: 0,
        hostOpenConnections: 0,
        protocols: {
          http: drainedProtocol(),
          sse: drainedProtocol(),
          websocket: drainedProtocol(),
          "task-submit": drainedProtocol(),
        },
      };
    case "process-state-drain":
      return {
        processes: cohort.goProcessIds.map((processId) => ({
          processId,
          status: "pass",
          observedAt: "2026-07-19T10:02:40.000Z",
          billingSessions: zeroObservation(),
          refundJobs: zeroObservation(),
          batchMaps: Object.fromEntries(
            REQUIRED_BATCH_MAPS.map((mapKind) => [mapKind, zeroObservation()]),
          ),
        })),
      };
    case "persistence-stability":
      return {
        batchIntervalSeconds: 30,
        exportIntervalSeconds: 60,
        snapshotIntervalSeconds: 60,
        sqlDatabaseIdentitySha256: candidate.sqlDatabaseIdentitySha256,
        logDatabaseIdentitySha256: candidate.logDatabaseIdentitySha256,
        flushes: [
          {
            sequence: 1,
            status: "pass",
            startedAt: "2026-07-19T10:00:31.000Z",
            completedAt: "2026-07-19T10:01:00.000Z",
          },
          {
            sequence: 2,
            status: "pass",
            startedAt: "2026-07-19T10:01:00.000Z",
            completedAt: "2026-07-19T10:01:31.000Z",
          },
        ],
        export: {
          status: "pass",
          startedAt: "2026-07-19T10:00:31.000Z",
          completedAt: "2026-07-19T10:01:31.000Z",
        },
        errorCounts: {
          batch: 0,
          export: 0,
          logWrite: 0,
          refund: 0,
          settlement: 0,
          tokenAdjustment: 0,
        },
        sqlSnapshots: stableSnapshotPair({
          firstAt: "2026-07-19T10:01:31.000Z",
          secondAt: "2026-07-19T10:02:31.000Z",
          label: "sql",
          rowCount: 1000,
        }),
        logDbSnapshots: stableSnapshotPair({
          firstAt: "2026-07-19T10:01:32.000Z",
          secondAt: "2026-07-19T10:02:32.000Z",
          label: "log-db",
          rowCount: 5000,
        }),
      };
    case "scheduler-ownership":
      return {
        inventoryStatus: "pass",
        expectedSchedulerCount: cohort.schedulerIds.length,
        discoveredSchedulerCount: cohort.schedulerIds.length,
        unknownSchedulerCount: 0,
        owners: cohort.schedulerIds.map((schedulerId) => ({
          schedulerId,
          status: "pass",
          ownerCount: 1,
          ownerSetDigestSha256: digestText(`owner:${schedulerId}`),
          observedAt: "2026-07-19T10:02:40.000Z",
        })),
      };
    case "bidirectional-sync":
      return {
        directions: {
          goToCloudflare: syncDirection("forward", 100),
          cloudflareToGo: syncDirection("reverse", 7),
        },
        reconciliation: Object.fromEntries(
          REQUIRED_RECONCILIATION_DOMAINS.map((domain) => {
            const digest = digestText(`reconciliation:${domain}`);
            return [
              domain,
              {
                status: "pass",
                differenceCount: 0,
                sourceDigestSha256: digest,
                targetDigestSha256: digest,
              },
            ];
          }),
        ),
      };
    case "pending-work":
      return {
        tasks: {
          status: "pass",
          capturedAt: "2026-07-19T10:02:45.000Z",
          disposition: "empty",
          sourcePendingCount: 0,
          durableHandoffCount: 0,
          targetReadbackCount: 0,
          unaccountedCount: 0,
          handoffDigestSha256: null,
        },
        orders: {
          status: "pass",
          capturedAt: "2026-07-19T10:02:45.000Z",
          disposition: "durable-handoff",
          sourcePendingCount: 2,
          durableHandoffCount: 2,
          targetReadbackCount: 2,
          unaccountedCount: 0,
          handoffDigestSha256: digestText("order-handoff"),
        },
      };
    case "rollback-bundle":
      return {
        bundleId: "rollback-prod-2026-07-19-a",
        restoreStatus: "pass",
        goReadinessStatus: "pass",
        sessionContinuityStatus: "pass",
        acceptedWritesIncludedStatus: "pass",
        rtoTargetSeconds: 300,
        measuredRtoSeconds: 120,
        rpoTargetSeconds: 0,
        measuredRpoSeconds: 0,
        rehearsalCompletedAt: "2026-07-19T10:02:50.000Z",
        components: REQUIRED_ROLLBACK_COMPONENTS.map((componentKind, index) => ({
          kind: componentKind,
          status: "pass",
          bytes: 1024 + index,
          digestSha256:
            componentKind === "go-runtime"
              ? candidate.goArtifactDigestSha256
              : digestText(`rollback:${componentKind}`),
          verifiedAt: "2026-07-19T10:02:50.000Z",
        })),
      };
    default:
      throw new Error(`unsupported fixture kind: ${kind}`);
  }
}

function drainedProtocol() {
  return {
    status: "pass",
    acceptedAfterDrainCount: 0,
    activeCount: 0,
    inFlightCount: 0,
  };
}

function zeroObservation() {
  return { status: "pass", count: 0 };
}

function stableSnapshotPair({ firstAt, secondAt, label, rowCount }) {
  const common = {
    status: "pass",
    rowCount,
    digestSha256: digestText(`${label}:snapshot`),
    chunkSetDigestSha256: digestText(`${label}:chunks`),
    highWatermarkSha256: digestText(`${label}:high-watermark`),
  };
  return [
    { ...common, capturedAt: firstAt },
    { ...common, capturedAt: secondAt },
  ];
}

function syncDirection(label, writeCount) {
  const writeSetDigest = digestText(`${label}:write-set`);
  const highWatermarkDigest = digestText(`${label}:high-watermark`);
  return {
    status: "pass",
    observedAt: "2026-07-19T10:02:45.000Z",
    lagRecordCount: 0,
    lagSeconds: 0,
    conflictCount: 0,
    unresolvedWriteCount: 0,
    acceptedWriteCount: writeCount,
    appliedWriteCount: writeCount,
    sourceWriteSetSha256: writeSetDigest,
    targetWriteSetSha256: writeSetDigest,
    sourceHighWatermarkSha256: highWatermarkDigest,
    targetHighWatermarkSha256: highWatermarkDigest,
  };
}

function digestObject(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function digestText(value) {
  return sha256Hex(Buffer.from(value, "utf8"));
}

async function writeCanonical(file, value) {
  await writeFile(file, `${canonicalJson(value)}\n`, "utf8");
}
