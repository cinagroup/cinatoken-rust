import { Database } from "bun:sqlite";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import {
  DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
  RING_TRANSITION_EXECUTION_CLAIM_CONTRACT,
  RING_TRANSITION_AUTHORITY_HEADER,
  RING_TRANSITION_EXECUTION_STEP_CONTRACT,
  RING_TRANSITION_EXPIRY_EVENT_CONTRACT,
  buildClaimAuthorityExpiryRequest,
  buildClaimAuthorityRequest,
  buildClaimAuthorityReadRequest,
  buildClaimAuthorityStepRequest,
  buildCloudflareDeploymentMutationRequest,
  buildRingTransitionExecutionClaim,
  buildRingTransitionClaimPermitSubject,
  classifyDeploymentMutationAttempt,
  describeRingTransitionMutationRunner,
  nextRingTransitionRunnerAction,
  ringTransitionTrustConfigDigestSha256,
  validatePublishedRingTransitionTrust,
} from "../tools/relay_container_ring_transition_execution_contract.mjs";
import {
  canonicalJson,
  sha256Hex,
} from "../tools/relay_container_p5_evidence_contract.mjs";

const migration0059Path = path.resolve(
  import.meta.dir,
  "../migrations/d1/0059_relay_container_ring_transition_claims.sql",
);
const migration0060Path = path.resolve(
  import.meta.dir,
  "../migrations/d1/0060_relay_container_ring_transition_authority.sql",
);
const runnerPath = path.resolve(
  import.meta.dir,
  "../tools/run_relay_container_ring_transition_mutation.mjs",
);
const accountId = "0123456789abcdef0123456789abcdef";
let migration0059Sql;
let migration0060Sql;
let tempRoot;

beforeAll(async () => {
  [migration0059Sql, migration0060Sql] = await Promise.all([
    readFile(migration0059Path, "utf8"),
    readFile(migration0060Path, "utf8"),
  ]);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "cinatoken-ring-execution-"));
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("Relay Container ring transition D1 claim ledger", () => {
  test("refuses authority enforcement while a 0059 claim is active", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(migration0059Sql);
    insertClaim(db);
    expect(
      migration0060Sql.indexOf(
        "migration_0060_ring_transition_authority_drain_guard",
      ),
    ).toBeLessThan(migration0060Sql.indexOf("ADD COLUMN transport_outcome"));
    db.exec(
      `CREATE TABLE migration_0060_ring_transition_authority_drain_guard (
         active_count INTEGER NOT NULL CHECK (active_count = 0)
       )`,
    );
    expect(() =>
      db
        .query(
          `INSERT INTO migration_0060_ring_transition_authority_drain_guard
             (active_count)
           SELECT COUNT(*)
           FROM relay_container_ring_transition_claims
           WHERE status IN (
             'claimed', 't1_verified', 'controller_inflight',
             'controller_verified', 'edge_prechecked', 'edge_inflight'
           )`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  test("claims once and advances only through persisted ordered evidence", () => {
    const db = createLedger();
    const claim = insertClaim(db);
    expect(readState(db, claim.authorizationIdSha256)).toEqual([
      "claimed",
      0,
      null,
    ]);

    insertStep(db, claim, 1, "t1_readback", "claimed", "t1_verified", {
      deploymentSetSha256: "1".repeat(64),
    });
    expect(() =>
      db
        .query(
          `UPDATE relay_container_ring_transition_claims
           SET status = 'controller_inflight', state_version = 2,
               updated_at = unixepoch()
           WHERE authorization_id_sha256 = ?1`,
        )
        .run(claim.authorizationIdSha256),
    ).toThrow(/matching authority evidence/);
    insertStep(
      db,
      claim,
      2,
      "controller_mutation_intent",
      "t1_verified",
      "controller_inflight",
      { mutationRequestSha256: "2".repeat(64) },
    );
    insertStep(
      db,
      claim,
      3,
      "controller_post_readback",
      "controller_inflight",
      "controller_verified",
      {
        mutationRequestSha256: "2".repeat(64),
        cloudflareRequestIdSha256: "3".repeat(64),
        deploymentSetSha256: "4".repeat(64),
      },
    );
    insertStep(
      db,
      claim,
      4,
      "edge_pre_readback",
      "controller_verified",
      "edge_prechecked",
      { deploymentSetSha256: "5".repeat(64) },
    );
    insertStep(
      db,
      claim,
      5,
      "edge_mutation_intent",
      "edge_prechecked",
      "edge_inflight",
      { mutationRequestSha256: "6".repeat(64) },
    );
    insertStep(
      db,
      claim,
      6,
      "edge_post_readback",
      "edge_inflight",
      "completed",
      {
        mutationRequestSha256: "6".repeat(64),
        cloudflareRequestIdSha256: "7".repeat(64),
        deploymentSetSha256: "8".repeat(64),
      },
    );

    const [status, version, terminalAt] = readState(
      db,
      claim.authorizationIdSha256,
    );
    expect(status).toBe("completed");
    expect(version).toBe(6);
    expect(Number.isInteger(terminalAt)).toBe(true);
    expect(
      db
        .query(
          "SELECT COUNT(*) FROM relay_container_ring_transition_steps",
        )
        .values()[0][0],
    ).toBe(6);
    db.close();
  });

  test("rejects replay, concurrent scope, skipped states, and evidence mutation", () => {
    const db = createLedger();
    const claim = insertClaim(db);
    expect(() => insertClaim(db, claim)).toThrow();
    expect(() =>
      insertClaim(db, {
        ...claim,
        authorizationIdSha256: "a".repeat(64),
        executionNonceSha256: "b".repeat(64),
        claimDigestSha256: "c".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      insertStep(
        db,
        claim,
        1,
        "edge_mutation_intent",
        "claimed",
        "edge_inflight",
        { mutationRequestSha256: "2".repeat(64) },
      ),
    ).toThrow();
    insertStep(db, claim, 1, "t1_readback", "claimed", "t1_verified", {
      deploymentSetSha256: "1".repeat(64),
    });
    expect(() =>
      db
        .query(
          "UPDATE relay_container_ring_transition_steps SET evidence_sha256 = ?1",
        )
        .run("f".repeat(64)),
    ).toThrow(/immutable/);
    expect(() =>
      db
        .query(
          "UPDATE relay_container_ring_transition_claims SET candidate_sha256 = ?1",
        )
        .run("f".repeat(64)),
    ).toThrow(/immutable/);
    db.close();
  });

  test("turns an ambiguous post-mutation readback into recovery, never retry", () => {
    const db = createLedger();
    const claim = insertClaim(db);
    insertStep(db, claim, 1, "t1_readback", "claimed", "t1_verified", {
      deploymentSetSha256: "1".repeat(64),
    });
    insertStep(
      db,
      claim,
      2,
      "controller_mutation_intent",
      "t1_verified",
      "controller_inflight",
      { mutationRequestSha256: "2".repeat(64) },
    );
    insertStep(
      db,
      claim,
      3,
      "controller_post_readback",
      "controller_inflight",
      "recovery_required",
      {
        mutationRequestSha256: "2".repeat(64),
        deploymentSetSha256: "3".repeat(64),
        failureClass: "transport_response_lost",
        transportOutcome: "ambiguous",
      },
    );
    expect(readState(db, claim.authorizationIdSha256)[0]).toBe(
      "recovery_required",
    );
    expect(() =>
      insertStep(
        db,
        claim,
        4,
        "controller_mutation_intent",
        "recovery_required",
        "controller_inflight",
        { mutationRequestSha256: "2".repeat(64) },
      ),
    ).toThrow();
    db.close();
  });

  test("binds post-readback to the persisted mutation intent", () => {
    const db = createLedger();
    const claim = insertClaim(db);
    insertStep(db, claim, 1, "t1_readback", "claimed", "t1_verified", {
      deploymentSetSha256: "1".repeat(64),
    });
    insertStep(
      db,
      claim,
      2,
      "controller_mutation_intent",
      "t1_verified",
      "controller_inflight",
      { mutationRequestSha256: "2".repeat(64) },
    );
    expect(() =>
      insertStep(
        db,
        claim,
        3,
        "controller_post_readback",
        "controller_inflight",
        "controller_verified",
        {
          mutationRequestSha256: "3".repeat(64),
          deploymentSetSha256: "4".repeat(64),
          transportOutcome: "success",
        },
      ),
    ).toThrow(/persisted mutation intent/);
    expect(readState(db, claim.authorizationIdSha256)).toEqual([
      "controller_inflight",
      2,
      null,
    ]);
    db.close();
  });

  test("never records a rejected transport as a verified mutation", () => {
    const db = createLedger();
    const claim = insertClaim(db);
    insertStep(db, claim, 1, "t1_readback", "claimed", "t1_verified", {
      deploymentSetSha256: "1".repeat(64),
    });
    insertStep(
      db,
      claim,
      2,
      "controller_mutation_intent",
      "t1_verified",
      "controller_inflight",
      { mutationRequestSha256: "2".repeat(64) },
    );
    expect(() =>
      insertStep(
        db,
        claim,
        3,
        "controller_post_readback",
        "controller_inflight",
        "controller_verified",
        {
          mutationRequestSha256: "2".repeat(64),
          deploymentSetSha256: "3".repeat(64),
          transportOutcome: "rejected",
        },
      ),
    ).toThrow(/lifecycle evidence/);
    insertStep(
      db,
      claim,
      3,
      "controller_post_readback",
      "controller_inflight",
      "recovery_required",
      {
        mutationRequestSha256: "2".repeat(64),
        deploymentSetSha256: "3".repeat(64),
        failureClass: "http_rejected",
        transportOutcome: "rejected",
      },
    );
    expect(readState(db, claim.authorizationIdSha256)[0]).toBe(
      "recovery_required",
    );
    db.close();
  });

  test("rejects early expiry and lets a distinct authority release stale pre-mutation scope", () => {
    const earlyDb = createLedger();
    const earlyClaim = insertClaim(earlyDb);
    expect(() =>
      insertExpiryEvent(earlyDb, earlyClaim, 1, "claimed", "expired"),
    ).toThrow(/expired active claim/);
    earlyDb.close();

    const { db, claim } = createExpiredLedger("claimed");
    insertExpiryEvent(db, claim, 1, "claimed", "expired");
    expect(readState(db, claim.authorizationIdSha256)[0]).toBe("expired");
    expect(() =>
      db
        .query(
          "UPDATE relay_container_ring_transition_expiry_events SET evidence_sha256 = ?1",
        )
        .run("f".repeat(64)),
    ).toThrow(/immutable/);
    expect(() =>
      insertClaim(db, {
        ...claim,
        authorizationIdSha256: "a".repeat(64),
        executionNonceSha256: "b".repeat(64),
        claimDigestSha256: "c".repeat(64),
      }),
    ).not.toThrow();
    db.close();
  });

  test("seals an expired post-mutation claim as recovery-required", () => {
    const { db, claim } = createExpiredLedger("controller_verified");
    insertExpiryEvent(
      db,
      claim,
      4,
      "controller_verified",
      "recovery_required",
    );
    expect(readState(db, claim.authorizationIdSha256)[0]).toBe(
      "recovery_required",
    );
    db.close();
  });
});

describe("Relay Container deployment-pinned mutation runner contract", () => {
  test("checked-in trust roots are deterministic and fail closed", () => {
    const first = describeRingTransitionMutationRunner();
    const second = describeRingTransitionMutationRunner();
    expect(first).toEqual(second);
    expect(first.trustRootsPublished).toBe(false);
    expect(first.remoteMutationAuthorized).toBe(false);
    expect(first.networkRequestsPerformed).toBe(false);
    expect(first.mutationPerformed).toBe(false);
    expect(() =>
      validatePublishedRingTransitionTrust(
        DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
      ),
    ).toThrow(/enablement/);
  });

  test("published anchors bind claims and emit fixed zero-retry requests", () => {
    const anchors = publishedAnchors();
    const authorization = authorizationFixture(anchors);
    const claim = buildRingTransitionExecutionClaim({
      authorization,
      anchors,
      actorExecutionIdSha256: "e".repeat(64),
      ledgerIdentitySha256: anchors.ledgerIdentitySha256,
    });
    expect(claim.contract).toBe(RING_TRANSITION_EXECUTION_CLAIM_CONTRACT);
    expect(claim.claimDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      new Set([
        claim.readCredentialIdSha256,
        claim.claimCredentialIdSha256,
        claim.deployCredentialIdSha256,
      ]).size,
    ).toBe(3);

    const permit = {
      ...buildRingTransitionClaimPermitSubject({
        claim,
        issuer: "cinatoken-ring-permit-staging",
        keyId: "permit-v1",
        issuedAt: claim.generatedAt + 1,
        expiresAt: claim.generatedAt + 60,
      }),
      signatureBase64url: "A".repeat(86),
    };
    const authorityToken = "authority-token.".padEnd(64, "a");
    const claimRequest = buildClaimAuthorityRequest({
      anchors,
      claim,
      permit,
      authorityToken,
    });
    expect(claimRequest.url).toBe(
      "https://ring-claim.staging.example.com/internal/v1/ring-transition/claims",
    );
    expect(claimRequest.retry).toBe(false);
    expect(claimRequest.body).not.toContain("poison-must-not-be-read");
    expect(JSON.parse(claimRequest.body)).toEqual({
      claim,
      contract: "cinatoken-ring-transition-claim-request-v1",
      permit,
      schemaVersion: 1,
    });
    expect(claimRequest.headers[RING_TRANSITION_AUTHORITY_HEADER]).toBe(
      authorityToken,
    );
    const readRequest = buildClaimAuthorityReadRequest({
      anchors,
      authorizationIdSha256: claim.authorizationIdSha256,
      claimDigestSha256: claim.claimDigestSha256,
      claimOwnerSha256: claim.claimOwnerSha256,
      authorityToken,
    });
    expect(readRequest.method).toBe("GET");
    expect(readRequest.retry).toBe(false);
    expect(readRequest.url).toContain(
      `/${claim.authorizationIdSha256}?claimDigestSha256=`,
    );
    const unsignedStep = {
      schemaVersion: 1,
      contract: RING_TRANSITION_EXECUTION_STEP_CONTRACT,
      ledgerIdentitySha256: claim.ledgerIdentitySha256,
      claimDigestSha256: claim.claimDigestSha256,
      stateVersion: 1,
      stepCode: "t1_readback",
      fromStatus: "claimed",
      toStatus: "t1_verified",
      mutationRequestSha256: null,
      cloudflareRequestIdSha256: null,
      deploymentSetSha256: "d".repeat(64),
      evidenceSha256: "e".repeat(64),
      failureClass: "",
      transportOutcome: "not_applicable",
    };
    const step = {
      ...unsignedStep,
      stepDigestSha256: sha256Hex(
        Buffer.from(canonicalJson(unsignedStep), "utf8"),
      ),
    };
    const stepRequest = buildClaimAuthorityStepRequest({
      anchors,
      authorizationIdSha256: claim.authorizationIdSha256,
      step,
      authorityToken,
    });
    expect(stepRequest.url).toEndWith(
      `/${claim.authorizationIdSha256}/steps`,
    );
    expect(stepRequest.retry).toBe(false);
    const unsignedExpiry = {
      schemaVersion: 1,
      contract: RING_TRANSITION_EXPIRY_EVENT_CONTRACT,
      ledgerIdentitySha256: claim.ledgerIdentitySha256,
      claimDigestSha256: claim.claimDigestSha256,
      stateVersion: 1,
      fromStatus: "claimed",
      toStatus: "expired",
      evidenceSha256: "f".repeat(64),
      failureClass: "authorization_expired",
    };
    const expiryEvent = {
      ...unsignedExpiry,
      expiryEventDigestSha256: sha256Hex(
        Buffer.from(canonicalJson(unsignedExpiry), "utf8"),
      ),
    };
    const expiryRequest = buildClaimAuthorityExpiryRequest({
      anchors,
      authorizationIdSha256: claim.authorizationIdSha256,
      expiryEvent,
      authorityToken,
    });
    expect(expiryRequest.url).toEndWith(
      `/${claim.authorizationIdSha256}/expire`,
    );
    expect(expiryRequest.retry).toBe(false);
    expect(() =>
      buildClaimAuthorityRequest({
        anchors,
        claim,
        permit: { ...permit, claimDigestSha256: "f".repeat(64) },
        authorityToken,
      }),
    ).toThrow(/claimDigestSha256 mismatch/);

    const mutation = buildCloudflareDeploymentMutationRequest({
      anchors,
      accountId,
      claim,
      phase: "controller",
      stateVersion: 2,
    });
    expect(mutation.retry).toBe(false);
    expect(mutation.force).toBe(false);
    expect(JSON.parse(mutation.body)).toEqual({
      annotations: {
        "workers/message": expect.stringMatching(
          /^cinatoken-ring-v1:1{64}:2:[0-9a-f]{64}$/,
        ),
      },
      strategy: "percentage",
      versions: [
        { percentage: 100, version_id: "controller-version-002" },
      ],
    });
    expect(mutation.url).not.toContain("{account_id}");
  });

  test("rejects approval-key, trust-config, and credential separation drift", () => {
    const anchors = publishedAnchors();
    const approvalDrift = authorizationFixture(anchors);
    approvalDrift.approvalKeys[0].publicKeySha256 = "f".repeat(64);
    expect(() =>
      buildRingTransitionExecutionClaim({
        authorization: approvalDrift,
        anchors,
        actorExecutionIdSha256: "e".repeat(64),
        ledgerIdentitySha256: anchors.ledgerIdentitySha256,
      }),
    ).toThrow(/approval key anchors/);

    const trustDrift = {
      ...anchors,
      controllerServiceName: "unreviewed-controller-staging",
    };
    expect(() => validatePublishedRingTransitionTrust(trustDrift)).toThrow(
      /configuration digest/,
    );

    const credentialDrift = authorizationFixture(anchors);
    credentialDrift.credentialScope.replacementClaimCredentialIdSha256 =
      credentialDrift.credentialScope.replacementReadCredentialIdSha256;
    expect(() =>
      buildRingTransitionExecutionClaim({
        authorization: credentialDrift,
        anchors,
        actorExecutionIdSha256: "e".repeat(64),
        ledgerIdentitySha256: anchors.ledgerIdentitySha256,
      }),
    ).toThrow(/credentials must be distinct/);

    expect(() =>
      validatePublishedRingTransitionTrust({
        ...anchors,
        authorizationApprovalKeyFingerprintsSha256: [
          "4".repeat(64),
          "7".repeat(64),
        ],
      }),
    ).toThrow(/signing key roles must be disjoint/);
    expect(() =>
      validatePublishedRingTransitionTrust({
        ...anchors,
        claimPermitSpkiSha256:
          anchors.transitionApprovalKeyFingerprintsSha256[0],
      }),
    ).toThrow(/signing key roles must be disjoint/);
  });

  test("classifies response loss only by stable authenticated target readback", () => {
    const target = "controller-version-002";
    const appliedReadback = {
      deploymentSetSha256: "1".repeat(64),
      activeVersions: [{ versionId: target, percentage: 100 }],
      mutationAnnotation:
        "cinatoken staging ring transition 1111111111111111",
    };
    expect(
      classifyDeploymentMutationAttempt({
        transportOutcome: "ambiguous",
        targetVersionId: target,
        authorizationIdSha256: "1".repeat(64),
        readbacks: [appliedReadback, appliedReadback],
      }),
    ).toEqual({
      classification: "confirmed-applied-after-response-loss",
      terminalState: "verified",
      retryMutation: false,
      forwardRepairRequired: false,
    });
    const drifted = {
      deploymentSetSha256: "2".repeat(64),
      activeVersions: [{ versionId: "controller-version-001", percentage: 100 }],
      mutationAnnotation:
        "cinatoken staging ring transition 1111111111111111",
    };
    const unresolved = classifyDeploymentMutationAttempt({
      transportOutcome: "ambiguous",
      targetVersionId: target,
      authorizationIdSha256: "1".repeat(64),
      readbacks: [drifted, { ...drifted, deploymentSetSha256: "3".repeat(64) }],
    });
    expect(unresolved.terminalState).toBe("recovery_required");
    expect(unresolved.retryMutation).toBe(false);
    expect(unresolved.forwardRepairRequired).toBe(true);
    expect(
      classifyDeploymentMutationAttempt({
        transportOutcome: "ambiguous",
        targetVersionId: target,
        authorizationIdSha256: "1".repeat(64),
        readbacks: [
          { ...appliedReadback, mutationAnnotation: "unrelated deployment" },
          { ...appliedReadback, mutationAnnotation: "unrelated deployment" },
        ],
      }),
    ).toEqual({
      classification: "recovery-required-target-not-confirmed",
      terminalState: "recovery_required",
      retryMutation: false,
      forwardRepairRequired: true,
    });
  });

  test("state actions never schedule a second write while mutation is inflight", () => {
    expect(nextRingTransitionRunnerAction("claimed")).toBe(
      "authenticated-t1-readback",
    );
    expect(nextRingTransitionRunnerAction("controller_inflight")).toBe(
      "authenticated-controller-post-readback",
    );
    expect(nextRingTransitionRunnerAction("edge_inflight")).toBe(
      "authenticated-edge-post-readback",
    );
    expect(nextRingTransitionRunnerAction("recovery_required")).toBeNull();
  });

  test("CLI ignores poison credentials in describe mode and rejects execution", () => {
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: tempRoot,
      TMP: tempRoot,
      CLOUDFLARE_API_TOKEN: "poison-must-not-be-read",
      CINATOKEN_RING_CLAIM_TOKEN: "poison-must-not-be-read",
      CINATOKEN_RING_DEPLOY_TOKEN: "poison-must-not-be-read",
    };
    const described = spawnSync(
      process.execPath,
      [runnerPath, "--describe", "--json"],
      { encoding: "utf8", env },
    );
    expect(described.status).toBe(0);
    expect(described.stderr).toBe("");
    const output = JSON.parse(described.stdout);
    expect(output.credentialsRead).toBe(false);
    expect(output.networkRequestsPerformed).toBe(false);

    const executed = spawnSync(
      process.execPath,
      [runnerPath, "--execute", "--json"],
      { encoding: "utf8", env },
    );
    expect(executed.status).toBe(1);
    expect(executed.stderr).toContain("trust roots are not published");
    expect(executed.stdout).toBe("");

    const override = spawnSync(
      process.execPath,
      [runnerPath, "--execute", "--api-token", "secret"],
      { encoding: "utf8", env },
    );
    expect(override.status).toBe(2);
    expect(override.stderr).toContain("unknown option");
  });
});

function createLedger() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migration0059Sql);
  db.exec(migration0060Sql);
  return db;
}

function createExpiredLedger(targetStatus) {
  const db = createLedger();
  const claim = insertClaim(db);
  if (targetStatus === "controller_verified") {
    insertStep(db, claim, 1, "t1_readback", "claimed", "t1_verified", {
      deploymentSetSha256: "1".repeat(64),
    });
    insertStep(
      db,
      claim,
      2,
      "controller_mutation_intent",
      "t1_verified",
      "controller_inflight",
      { mutationRequestSha256: "2".repeat(64) },
    );
    insertStep(
      db,
      claim,
      3,
      "controller_post_readback",
      "controller_inflight",
      "controller_verified",
      {
        mutationRequestSha256: "2".repeat(64),
        deploymentSetSha256: "3".repeat(64),
        transportOutcome: "success",
      },
    );
  }
  const claimUpdateTriggerSql = db
    .query(
      `SELECT sql
       FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'relay_container_ring_transition_claim_update_guard'`,
    )
    .values()[0][0];
  db.exec("DROP TRIGGER relay_container_ring_transition_claim_update_guard");
  db.query(
    `UPDATE relay_container_ring_transition_claims
     SET expires_at = unixepoch() - 1
     WHERE authorization_id_sha256 = ?1`,
  ).run(claim.authorizationIdSha256);
  db.exec(claimUpdateTriggerSql);
  return { db, claim };
}

function insertClaim(db, overrides = {}) {
  const now = db.query("SELECT unixepoch()").values()[0][0];
  const claim = {
    authorizationIdSha256: "1".repeat(64),
    executionNonceSha256: "2".repeat(64),
    authorizationManifestSha256: "3".repeat(64),
    authorizationSubjectSha256: "4".repeat(64),
    authorizationPolicySha256: "5".repeat(64),
    transitionManifestSha256: "6".repeat(64),
    transitionSubjectSha256: "7".repeat(64),
    transitionPolicySha256: "8".repeat(64),
    transitionPlanSha256: "9".repeat(64),
    candidateSha256: "a".repeat(64),
    executionPlanSha256: "b".repeat(64),
    accountIdSha256: "c".repeat(64),
    ledgerIdentitySha256: "d".repeat(64),
    readCredentialIdSha256: "e".repeat(64),
    claimCredentialIdSha256: "f".repeat(64),
    deployCredentialIdSha256: "0".repeat(64),
    controllerServiceName: "cinatoken-container-controller-staging",
    controllerPreviousVersionId: "controller-version-001",
    controllerPreviousDeploymentSetSha256: "1".repeat(64),
    controllerTargetVersionId: "controller-version-002",
    edgeServiceName: "cinatoken-rust-api-staging",
    edgePreviousVersionId: "edge-version-001",
    edgePreviousDeploymentSetSha256: "2".repeat(64),
    edgeTargetVersionId: "edge-version-002",
    runnerBuildSha256: "3".repeat(64),
    runnerTrustConfigSha256: "4".repeat(64),
    claimOwnerSha256: "5".repeat(64),
    claimDigestSha256: "6".repeat(64),
    generatedAt: now,
    expiresAt: now + 300,
    ...overrides,
  };
  db.query(
    `INSERT INTO relay_container_ring_transition_claims (
       authorization_id_sha256, execution_nonce_sha256,
       claim_contract, claim_scope, environment,
       authorization_manifest_sha256, authorization_subject_sha256,
       authorization_policy_sha256, transition_manifest_sha256,
       transition_subject_sha256, transition_policy_sha256,
       transition_plan_sha256, candidate_sha256, execution_plan_sha256,
       account_id_sha256, ledger_identity_sha256,
       read_credential_id_sha256, claim_credential_id_sha256,
       deploy_credential_id_sha256,
       controller_service_name, controller_previous_version_id,
       controller_previous_deployment_set_sha256, controller_target_version_id,
       edge_service_name, edge_previous_version_id,
       edge_previous_deployment_set_sha256, edge_target_version_id,
       runner_build_sha256, runner_trust_config_sha256,
       claim_owner_sha256, claim_digest_sha256,
       status, state_version, generated_at, claimed_at,
       expires_at, updated_at, terminal_at
     ) VALUES (
       ?1, ?2, 'd1-unique-claim-v1', 'staging-worker-ring-transition', 'staging',
       ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
       ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
       'claimed', 0, ?29, unixepoch(), ?30, unixepoch(), NULL
     )`,
  ).run(
    claim.authorizationIdSha256,
    claim.executionNonceSha256,
    claim.authorizationManifestSha256,
    claim.authorizationSubjectSha256,
    claim.authorizationPolicySha256,
    claim.transitionManifestSha256,
    claim.transitionSubjectSha256,
    claim.transitionPolicySha256,
    claim.transitionPlanSha256,
    claim.candidateSha256,
    claim.executionPlanSha256,
    claim.accountIdSha256,
    claim.ledgerIdentitySha256,
    claim.readCredentialIdSha256,
    claim.claimCredentialIdSha256,
    claim.deployCredentialIdSha256,
    claim.controllerServiceName,
    claim.controllerPreviousVersionId,
    claim.controllerPreviousDeploymentSetSha256,
    claim.controllerTargetVersionId,
    claim.edgeServiceName,
    claim.edgePreviousVersionId,
    claim.edgePreviousDeploymentSetSha256,
    claim.edgeTargetVersionId,
    claim.runnerBuildSha256,
    claim.runnerTrustConfigSha256,
    claim.claimOwnerSha256,
    claim.claimDigestSha256,
    claim.generatedAt,
    claim.expiresAt,
  );
  return claim;
}

function insertStep(
  db,
  claim,
  stateVersion,
  stepCode,
  fromStatus,
  toStatus,
  {
    mutationRequestSha256 = null,
    cloudflareRequestIdSha256 = null,
    deploymentSetSha256 = null,
    failureClass = "",
    transportOutcome =
      stepCode === "controller_post_readback" ||
      stepCode === "edge_post_readback"
        ? "success"
        : "not_applicable",
  },
) {
  db.query(
    `INSERT INTO relay_container_ring_transition_steps (
       authorization_id_sha256, state_version, step_code,
       from_status, to_status, actor_execution_id_sha256,
       mutation_request_sha256, cloudflare_request_id_sha256,
       deployment_set_sha256, evidence_sha256, failure_class,
       step_digest_sha256, recorded_at, transport_outcome
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, unixepoch(), ?13
     )`,
  ).run(
    claim.authorizationIdSha256,
    stateVersion,
    stepCode,
    fromStatus,
    toStatus,
    claim.claimOwnerSha256,
    mutationRequestSha256,
    cloudflareRequestIdSha256,
    deploymentSetSha256,
    sha256Hex(Buffer.from(`evidence-${stateVersion}`, "utf8")),
    failureClass,
    sha256Hex(Buffer.from(`step-${stateVersion}`, "utf8")),
    transportOutcome,
  );
}

function insertExpiryEvent(
  db,
  claim,
  stateVersion,
  fromStatus,
  toStatus,
) {
  db.query(
    `INSERT INTO relay_container_ring_transition_expiry_events (
       authorization_id_sha256, state_version, from_status, to_status,
       authority_actor_id_sha256, evidence_sha256,
       expiry_event_digest_sha256, failure_class, recorded_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'authorization_expired', unixepoch()
     )`,
  ).run(
    claim.authorizationIdSha256,
    stateVersion,
    fromStatus,
    toStatus,
    "7".repeat(64),
    sha256Hex(Buffer.from(`expiry-evidence-${stateVersion}`, "utf8")),
    sha256Hex(Buffer.from(`expiry-event-${stateVersion}`, "utf8")),
  );
}

function readState(db, authorizationIdSha256) {
  return db
    .query(
      `SELECT status, state_version, terminal_at
       FROM relay_container_ring_transition_claims
       WHERE authorization_id_sha256 = ?1`,
    )
    .values(authorizationIdSha256)[0];
}

function publishedAnchors() {
  const anchors = {
    ...DEPLOYMENT_PINNED_RING_TRANSITION_TRUST,
    enabled: true,
    claimAuthorityOrigin: "https://ring-claim.staging.example.com",
    claimAuthorityVersionId: "authority-version-001",
    claimAuthorityIssuer: "cinatoken-ring-runner-staging",
    claimAuthorityAudience: "cinatoken-ring-transition-authority-staging",
    claimAuthorityHmacKeyId: "claim-hmac-v1",
    claimPermitIssuer: "cinatoken-ring-permit-staging",
    claimPermitKeyId: "permit-v1",
    claimPermitSpkiSha256: "c".repeat(64),
    accountIdSha256: sha256Hex(Buffer.from(accountId, "utf8")),
    ledgerIdentitySha256: "1".repeat(64),
    transitionPolicySha256: "2".repeat(64),
    authorizationPolicySha256: "3".repeat(64),
    transitionApprovalKeyFingerprintsSha256: [
      "4".repeat(64),
      "5".repeat(64),
    ],
    authorizationApprovalKeyFingerprintsSha256: [
      "6".repeat(64),
      "7".repeat(64),
    ],
    runnerSourceCommit: "8".repeat(40),
    runnerBuildSha256: "9".repeat(64),
    runnerTrustConfigSha256: "0".repeat(64),
    releaseEvidenceSha256: "a".repeat(64),
  };
  anchors.runnerTrustConfigSha256 =
    ringTransitionTrustConfigDigestSha256(anchors);
  return anchors;
}

function authorizationFixture(anchors) {
  const generatedAt = "2026-07-23T10:00:00.000Z";
  const expiresAt = "2026-07-23T10:10:00.000Z";
  return {
    ok: true,
    environment: "staging",
    offlineSignedAuthorizationVerified: true,
    atomicRemoteClaimRequired: true,
    mutationPerformedByVerifier: false,
    authorizationIdSha256: "1".repeat(64),
    executionNonceSha256: "2".repeat(64),
    authorizationManifestDigestSha256: "3".repeat(64),
    authorizationSubjectDigestSha256: "4".repeat(64),
    authorizationPolicyDigestSha256: anchors.authorizationPolicySha256,
    transitionManifestDigestSha256: "5".repeat(64),
    transitionSubjectDigestSha256: "6".repeat(64),
    transitionPolicyDigestSha256: anchors.transitionPolicySha256,
    transitionApprovalKeys:
      anchors.transitionApprovalKeyFingerprintsSha256.map(
        (publicKeySha256) => ({ publicKeySha256 }),
      ),
    approvalKeys:
      anchors.authorizationApprovalKeyFingerprintsSha256.map(
        (publicKeySha256) => ({ publicKeySha256 }),
      ),
    transitionPlanDigestSha256: "7".repeat(64),
    candidateDigestSha256: "8".repeat(64),
    executionPlanDigestSha256: "9".repeat(64),
    deploymentSetReadback: {
      accountIdSha256: anchors.accountIdSha256,
    },
    credentialScope: {
      replacementReadCredentialIdSha256: "a".repeat(64),
      replacementClaimCredentialIdSha256: "b".repeat(64),
      replacementDeployCredentialIdSha256: "c".repeat(64),
    },
    executionPlan: {
      generatedAt,
      controller: {
        serviceName: anchors.controllerServiceName,
        expectedVersionId: "controller-version-001",
        expectedDeploymentSetSha256: "d".repeat(64),
        targetVersionId: "controller-version-002",
      },
      edge: {
        serviceName: anchors.edgeServiceName,
        expectedVersionId: "edge-version-001",
        expectedDeploymentSetSha256: "e".repeat(64),
        targetVersionId: "edge-version-002",
      },
    },
    expiresAt,
  };
}
