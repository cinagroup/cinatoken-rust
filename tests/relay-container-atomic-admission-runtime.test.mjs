import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const userId = 501;
const tokenId = 502;
const channelId = 503;
const initialUserQuota = 1_000;
const initialTokenQuota = 500;
const reservedQuota = 125;
const admissionScopeId =
  "53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251";
const admissionFenceId = "6".repeat(64);
const acceptedSourceSchemaSha256 =
  "fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
  await seedAdmissionFence();
});

afterEach(async () => {
  await reset();
});

describe("migration 0050 atomic relay Container admission", () => {
  it("matches the Rust admission commit digest vector", async () => {
    expect(
      await relayContainerAdmissionCommitSha256({
        environment: "local",
        scopeKind: "global",
        scopeIdSha256: admissionScopeId,
        admissionFenceIdSha256: hex("a"),
        reservationKey: "relayreserve-test",
        operationId: "relayreserve-test",
        atomicAdmissionSha256: hex("1"),
        operationAdmissionSha256: hex("a"),
        billingSnapshotSha256:
          "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        clientRequestSha256: hex("e"),
        fenceGeneration: 1,
        ownerGeneration: 2,
        ringGeneration: 1,
        shardCount: 8,
        shardIndex: 3,
      }),
    ).toBe("54a3336866b7ff94e975fa7335e3979955ff3062853179c4622a321f26c003d1");
  });

  it("pins the cross-runtime idempotency alias-set digest", async () => {
    await expect(idempotencyAliasesSha256([hex("a"), hex("b")])).resolves.toBe(
      "2abe3436ba079ee481e8992885fa43931306e177fce6ce8eefd51a3f360c6393",
    );
    await expect(idempotencyAliasesSha256([hex("b"), hex("a")])).resolves.toBe(
      "2abe3436ba079ee481e8992885fa43931306e177fce6ce8eefd51a3f360c6393",
    );
  });

  it("commits the selected reservation, both debits, operation, and receipt once", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("success");

    const results = await runAtomicAdmissionBatch(intent);

    expect(results).toHaveLength(17);
    expect(results.map((result) => result.meta.changes)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);
    expect(await atomicAdmissionState(intent)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: intent.createdAt,
      },
      channel: { used_quota: 0 },
      counts: {
        reservations: 1,
        operations: 1,
        admissions: 1,
        aliases: 1,
        commits: 1,
      },
    });
    expect(await classifyAtomicAdmission(intent)).toBe("matching_resumable");
  });

  it("closes one nonempty accepted set and creates its campaign in one D1 command", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("drain-close");
    await runAtomicAdmissionBatch(intent);
    const commit = await env.DB.prepare(
      `SELECT accepted_sequence
       FROM relay_container_admission_commits
       WHERE operation_id = ?1`,
    )
      .bind(intent.operationId)
      .first();
    expect(commit).toEqual({ accepted_sequence: 1 });

    const source = await sealAcceptedSource([intent], { pageSize: 1 });
    const command = await drainCloseCommand(intent, source);
    await drainCloseCommandStatement(command).run();

    const readback = await env.DB.prepare(
      `SELECT command.close_command_id_sha256,
              command.command_digest_sha256,
              command.created_at AS command_created_at,
              fence.admission_open,
              fence.closed_campaign_id,
              fence.closed_at,
              campaign.cutoff_at,
              campaign.created_at AS campaign_created_at,
              campaign.accepted_high_watermark,
              campaign.accepted_member_count,
              campaign.accepted_first_sequence,
              campaign.accepted_first_operation_id,
              campaign.accepted_last_sequence,
              campaign.accepted_last_operation_id,
              campaign.state,
              campaign.state_version
       FROM relay_container_drain_close_commands AS command
       JOIN relay_container_admission_fences AS fence
         ON fence.admission_fence_id_sha256 =
              command.admission_fence_id_sha256
       JOIN relay_container_drain_campaigns AS campaign
         ON campaign.campaign_id = command.campaign_id
       WHERE command.close_command_id_sha256 = ?1`,
    )
      .bind(command.closeCommandIdSha256)
      .first();
    expect(readback).toMatchObject({
      close_command_id_sha256: command.closeCommandIdSha256,
      command_digest_sha256: command.commandDigestSha256,
      admission_open: 0,
      closed_campaign_id: command.campaignId,
      accepted_high_watermark: 1,
      accepted_member_count: 1,
      accepted_first_sequence: 1,
      accepted_first_operation_id: intent.operationId,
      accepted_last_sequence: 1,
      accepted_last_operation_id: intent.operationId,
      state: "fenced",
      state_version: 0,
    });
    expect(readback.command_created_at).toBe(readback.closed_at);
    expect(readback.command_created_at).toBe(readback.cutoff_at);
    expect(readback.command_created_at).toBe(readback.campaign_created_at);

    await expect(drainCloseCommandStatement(command).run()).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_drain_close_commands
         WHERE close_command_id_sha256 = ?1`,
      )
        .bind(command.closeCommandIdSha256)
        .first(),
    ).resolves.toEqual({ count: 1 });

    const late = await atomicAdmissionIntent("drain-close-late", {
      atomicAdmissionSha256: hex("4"),
      operationAdmissionSha256: hex("5"),
      clientIdempotencyHmacSha256: hex("2"),
      clientIdempotencyHmacAliases: [hex("2")],
      clientRequestSha256: hex("3"),
      reconciliationId: hex("1"),
      inputSha256: hex("0"),
    });
    await expect(runAtomicAdmissionBatch(late)).rejects.toThrow(
      /relay container admission fence is closed or stale/,
    );
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_admission_commits
            WHERE operation_id = ?1) AS commits,
           (SELECT COUNT(*) FROM relay_container_atomic_admissions
            WHERE operation_id = ?1) AS admissions,
           (SELECT COUNT(*) FROM relay_container_operations
            WHERE operation_id = ?1) AS operations`,
      )
        .bind(late.operationId)
        .first(),
    ).resolves.toEqual({ commits: 0, admissions: 0, operations: 0 });
  });

  it("closes a deterministic multi-page, multi-shard accepted source seal", async () => {
    await seedAuthorityState();
    const intents = await admitAcceptedSet("drain-source-multi", [0, 3, 7]);
    const source = await sealAcceptedSource(intents, { pageSize: 2 });
    const command = await drainCloseCommand(intents[0], source);

    await drainCloseCommandStatement(command).run();

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_drain_source_members
            WHERE source_scan_id_sha256 = ?1) AS members,
           (SELECT COUNT(*) FROM relay_container_drain_source_pages
            WHERE source_scan_id_sha256 = ?1) AS pages,
           (SELECT COUNT(*) FROM relay_container_drain_source_shards
            WHERE source_scan_id_sha256 = ?1) AS shards,
           (SELECT COUNT(*) FROM relay_container_drain_source_seals
            WHERE source_scan_id_sha256 = ?1) AS seals,
           (SELECT COUNT(*) FROM relay_container_drain_source_authorizations
            WHERE source_scan_id_sha256 = ?1) AS authorizations,
           (SELECT COUNT(*) FROM relay_container_drain_source_attestations
            WHERE source_scan_id_sha256 = ?1) AS attestations,
           (SELECT COUNT(*) FROM
              relay_container_drain_source_authorization_registrations
            WHERE source_scan_id_sha256 = ?1) AS registrations,
           (SELECT COUNT(*) FROM
              relay_container_drain_source_authorization_claims
            WHERE authorization_id_sha256 = ?3) AS claims,
           (SELECT COUNT(*) FROM
              relay_container_drain_source_terminal_receipts
            WHERE authorization_id_sha256 = ?3) AS terminals,
           (SELECT COUNT(*) FROM relay_container_drain_source_receipt_ledger
            WHERE authorization_id_sha256 = ?3) AS ledger_rows,
           (SELECT COUNT(*) FROM relay_container_drain_close_commands
            WHERE close_command_id_sha256 = ?2) AS commands`,
      )
        .bind(
          source.sourceScanIdSha256,
          command.closeCommandIdSha256,
          source.authorizationIdSha256,
        )
        .first(),
    ).resolves.toEqual({
      members: 3,
      pages: 2,
      shards: 8,
      seals: 1,
      authorizations: 1,
      attestations: 2,
      registrations: 1,
      claims: 1,
      terminals: 1,
      ledger_rows: 3,
      commands: 1,
    });
    await expect(
      env.DB.prepare(
        `SELECT accepted_high_watermark, accepted_member_count,
                accepted_first_operation_id, accepted_last_operation_id,
                state
         FROM relay_container_drain_campaigns
         WHERE campaign_id = ?1`,
      )
        .bind(command.campaignId)
        .first(),
    ).resolves.toEqual({
      accepted_high_watermark: 3,
      accepted_member_count: 3,
      accepted_first_operation_id: intents[0].operationId,
      accepted_last_operation_id: intents[2].operationId,
      state: "fenced",
    });
  });

  it("rejects a complete accepted source seal without both attestations", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-no-attestation", [
      3,
    ]);
    const source = await prepareAcceptedSource([intent], { pageSize: 1 });

    await expect(sourceSealStatement(source).run()).rejects.toThrow(
      /drain source seal is only an atomic successful terminal projection/,
    );
    await expect(sourceTerminalStatement(source).run()).rejects.toThrow(
      /successful drain source receipt requires exact unsealed attestations/,
    );
  });

  it("reports trigger-aware fresh and replay changes through first-primary Session batches", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet(
      "drain-source-session-terminal",
      [3],
    );
    const session = env.DB.withSession("first-primary");
    const source = await prepareAcceptedSource([intent], {
      pageSize: 1,
      includeClaim: false,
      claimAuthorization: async (candidate) => {
        const fresh = await session.batch([
          sourceClaimRepositoryStatement(session, candidate),
        ]);
        expect(fresh).toHaveLength(1);
        expect(fresh[0].success).toBe(true);
        expect(fresh[0].meta.changes).toBe(2);
        const freshBookmark = session.getBookmark();
        expect(typeof freshBookmark).toBe("string");
        expect(freshBookmark.length).toBeGreaterThan(0);

        const replay = await session.batch([
          sourceClaimRepositoryStatement(session, candidate),
        ]);
        expect(replay).toHaveLength(1);
        expect(replay[0].success).toBe(true);
        expect(replay[0].meta.changes).toBe(0);
        const replayBookmark = session.getBookmark();
        expect(typeof replayBookmark).toBe("string");
        expect(replayBookmark.length).toBeGreaterThan(0);
      },
    });
    await attestAcceptedSource(source);

    const fresh = await session.batch([
      sourceTerminalRepositoryStatement(session, source),
    ]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].success).toBe(true);
    expect(fresh[0].meta.changes).toBe(3);
    const freshBookmark = session.getBookmark();
    expect(typeof freshBookmark).toBe("string");
    expect(freshBookmark.length).toBeGreaterThan(0);

    const replay = await session.batch([
      sourceTerminalRepositoryStatement(session, source),
    ]);
    expect(replay).toHaveLength(1);
    expect(replay[0].success).toBe(true);
    expect(replay[0].meta.changes).toBe(0);
    const replayBookmark = session.getBookmark();
    expect(typeof replayBookmark).toBe("string");
    expect(replayBookmark.length).toBeGreaterThan(0);

    await expect(
      session
        .prepare(
          `SELECT terminal.authorization_id_sha256,
                  terminal.terminal_outcome,
                  terminal.terminal_phase,
                  terminal.source_scan_id_sha256,
                  terminal.source_seal_id_sha256,
                  terminal.source_seal_digest_sha256,
                  terminal.evidence_object_key,
                  terminal.terminal_receipt_sha256,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_seals
                   WHERE source_scan_id_sha256 =
                         terminal.source_scan_id_sha256) AS seals,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_terminal_receipts
                   WHERE authorization_id_sha256 =
                         terminal.authorization_id_sha256) AS terminals,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_receipt_ledger
                   WHERE authorization_id_sha256 =
                         terminal.authorization_id_sha256) AS ledger_rows
           FROM relay_container_drain_source_terminal_receipts AS terminal
           WHERE terminal.authorization_id_sha256 = ?1`,
        )
        .bind(source.authorizationIdSha256)
        .first(),
    ).resolves.toEqual({
      authorization_id_sha256: source.authorizationIdSha256,
      terminal_outcome: "succeeded",
      terminal_phase: "evidence",
      source_scan_id_sha256: source.sourceScanIdSha256,
      source_seal_id_sha256: source.sourceSealIdSha256,
      source_seal_digest_sha256: source.sealDigestSha256,
      evidence_object_key:
        `relay-container/p5/0073/${source.authorizationIdSha256}.json`,
      terminal_receipt_sha256: source.terminalReceiptSha256,
      seals: 1,
      terminals: 1,
      ledger_rows: 3,
    });
  });

  it("reports a no-seal failed terminal as two trigger-aware changes", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-session-expired", [
      3,
    ]);
    const session = env.DB.withSession("first-primary");
    const source = await prepareAcceptedSource([intent], {
      pageSize: 1,
      includeClaim: false,
      collectSource: false,
      claimAuthorization: async (candidate) => {
        const fresh = await session.batch([
          sourceClaimRepositoryStatement(session, candidate),
        ]);
        expect(fresh).toHaveLength(1);
        expect(fresh[0].success).toBe(true);
        expect(fresh[0].meta.changes).toBe(2);
      },
    });

    const failedTerminal = {
      terminalOutcome: "failed",
      terminalPhase: "claim",
      sourceSealIdSha256: null,
      sourceSealDigestSha256: null,
      failureClass: "collector-unavailable",
      ambiguityClass: null,
      evidenceManifestSha256: null,
      evidenceObjectKey: null,
      evidenceObjectVersionSha256: null,
      evidenceObjectEtagSha256: null,
      evidenceContentSha256: null,
      evidenceBytes: null,
      retentionPolicySha256: null,
      reasonCode: "source-collection-failed",
    };
    const fresh = await session.batch([
      sourceTerminalRepositoryStatement(session, source, failedTerminal),
    ]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].success).toBe(true);
    expect(fresh[0].meta.changes).toBe(2);
    expect(session.getBookmark()).toEqual(expect.any(String));

    const replay = await session.batch([
      sourceTerminalRepositoryStatement(session, source, failedTerminal),
    ]);
    expect(replay).toHaveLength(1);
    expect(replay[0].success).toBe(true);
    expect(replay[0].meta.changes).toBe(0);
    expect(session.getBookmark()).toEqual(expect.any(String));

    await expect(
      session
        .prepare(
          `SELECT terminal.terminal_outcome,
                  terminal.terminal_phase,
                  terminal.source_seal_id_sha256,
                  terminal.source_seal_digest_sha256,
                  terminal.evidence_object_key,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_scans
                   WHERE source_scan_id_sha256 =
                         terminal.source_scan_id_sha256) AS scans,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_seals
                   WHERE source_scan_id_sha256 =
                         terminal.source_scan_id_sha256) AS seals,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_terminal_receipts
                   WHERE authorization_id_sha256 =
                         terminal.authorization_id_sha256) AS terminals,
                  (SELECT COUNT(*)
                   FROM relay_container_drain_source_receipt_ledger
                   WHERE authorization_id_sha256 =
                         terminal.authorization_id_sha256) AS ledger_rows
           FROM relay_container_drain_source_terminal_receipts AS terminal
           WHERE terminal.authorization_id_sha256 = ?1`,
        )
        .bind(source.authorizationIdSha256)
        .first(),
    ).resolves.toEqual({
      terminal_outcome: "failed",
      terminal_phase: "claim",
      source_seal_id_sha256: null,
      source_seal_digest_sha256: null,
      evidence_object_key: null,
      scans: 0,
      seals: 0,
      terminals: 1,
      ledger_rows: 3,
    });
  });

  it("rejects ASCII controls in evidence keys without rejecting literal c] or n]", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-evidence-key", [3]);
    const source = await prepareAcceptedSource([intent], { pageSize: 1 });
    await attestAcceptedSource(source);

    const asciiControlCodePoints = [
      ...Array.from({ length: 0x20 }, (_, codePoint) => codePoint),
      0x7f,
    ];
    for (const codePoint of asciiControlCodePoints) {
      const evidenceObjectKey =
        `relay-container/p5/0073/control-` +
        `${String.fromCharCode(codePoint)}-evidence.json`;
      await expect(
        sourceTerminalStatement(source, { evidenceObjectKey }).run(),
      ).rejects.toThrow(/CHECK constraint failed/);
    }

    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_drain_source_seals
            WHERE source_scan_id_sha256 = ?1) AS seals,
           (SELECT COUNT(*) FROM relay_container_drain_source_terminal_receipts
            WHERE authorization_id_sha256 = ?2) AS terminals,
           (SELECT COUNT(*) FROM relay_container_drain_source_receipt_ledger
            WHERE authorization_id_sha256 = ?2) AS ledger_rows`,
      )
        .bind(source.sourceScanIdSha256, source.authorizationIdSha256)
        .first(),
    ).resolves.toEqual({ seals: 0, terminals: 0, ledger_rows: 2 });

    const validEvidenceObjectKey =
      "relay-container/p5/0073/literal-c]/literal-n]/evidence.json";
    await expect(
      sourceTerminalStatement(source, {
        evidenceObjectKey: validEvidenceObjectKey,
      }).run(),
    ).resolves.toBeDefined();
    await expect(
      env.DB.prepare(
        `SELECT evidence_object_key
         FROM relay_container_drain_source_terminal_receipts
         WHERE authorization_id_sha256 = ?1`,
      )
        .bind(source.authorizationIdSha256)
        .first(),
    ).resolves.toEqual({ evidence_object_key: validEvidenceObjectKey });
  });

  it("rejects accepted-source collection before the authorization is claimed", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-unclaimed", [3]);

    await expect(
      prepareAcceptedSource([intent], {
        pageSize: 1,
        includeClaim: false,
      }),
    ).rejects.toThrow(
      /drain source scan requires the exact live authorization claim/,
    );
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_drain_source_scans)
             AS scans,
           (SELECT COUNT(*) FROM
              relay_container_drain_source_authorization_registrations)
             AS registrations,
           (SELECT COUNT(*) FROM
              relay_container_drain_source_authorization_claims)
             AS claims,
           (SELECT COUNT(*) FROM relay_container_drain_source_receipt_ledger)
             AS ledger_rows`,
      ).first(),
    ).resolves.toEqual({
      scans: 0,
      registrations: 1,
      claims: 0,
      ledger_rows: 1,
    });
    await expect(
      env.DB.prepare(
        "DELETE FROM passkey_credentials WHERE user_id = ?1",
      )
        .bind(42)
        .run(),
    ).resolves.toBeDefined();
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_drain_source_authorization_registrations`,
      ).first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("rejects verifier snapshot drift and assembler key reuse", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-attestation-drift", [
      3,
    ]);
    const source = await prepareAcceptedSource([intent], { pageSize: 1 });
    await sourceAttestationStatement(source, "assembler").run();

    await expect(
      sourceAttestationStatement(source, "verifier", {
        acceptedSetManifestSha256: await sha256Text(
          "runtime-divergent-accepted-set",
        ),
      }).run(),
    ).rejects.toThrow(/ordered independent roles/);
    await expect(
      sourceAttestationStatement(source, "verifier", {
        signerSpkiSha256: source.assemblerSpkiSha256,
      }).run(),
    ).rejects.toThrow();
  });

  it("rejects an accepted source seal with a missing page", async () => {
    await seedAuthorityState();
    const intents = await admitAcceptedSet("drain-source-missing-page", [
      0, 3, 7,
    ]);
    const source = await prepareAcceptedSource(intents, {
      pageSize: 2,
      omittedPageOrdinals: [2],
    });

    await expect(attestAcceptedSource(source)).rejects.toThrow(
      /drain source attestation is incomplete, stale, or unauthorized/,
    );
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_drain_source_seals
         WHERE source_scan_id_sha256 = ?1`,
      )
        .bind(source.sourceScanIdSha256)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rejects an accepted source seal with a missing shard manifest", async () => {
    await seedAuthorityState();
    const intents = await admitAcceptedSet("drain-source-missing-shard", [3]);
    const source = await prepareAcceptedSource(intents, {
      pageSize: 1,
      omittedShardIndexes: [7],
    });

    await expect(attestAcceptedSource(source)).rejects.toThrow(
      /drain source attestation is incomplete, stale, or unauthorized/,
    );
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_drain_source_shards
         WHERE source_scan_id_sha256 = ?1`,
      )
        .bind(source.sourceScanIdSha256)
        .first(),
    ).resolves.toEqual({ count: 7 });
  });

  it("rolls back terminal and ledger when atomic seal projection detects a late admission", async () => {
    await seedAuthorityState();
    const [accepted] = await admitAcceptedSet(
      "drain-source-terminal-before-late",
      [3],
    );
    const source = await prepareAcceptedSource([accepted], { pageSize: 1 });
    await attestAcceptedSource(source);
    await admitAcceptedSet("drain-source-terminal-late", [7]);

    await expect(sourceTerminalStatement(source).run()).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_drain_source_seals
            WHERE source_scan_id_sha256 = ?1) AS seals,
           (SELECT COUNT(*) FROM relay_container_drain_source_terminal_receipts
            WHERE authorization_id_sha256 = ?2) AS terminals,
           (SELECT COUNT(*) FROM relay_container_drain_source_receipt_ledger
            WHERE authorization_id_sha256 = ?2) AS ledger_rows`,
      )
        .bind(source.sourceScanIdSha256, source.authorizationIdSha256)
        .first(),
    ).resolves.toEqual({ seals: 0, terminals: 0, ledger_rows: 2 });
  });

  it("rejects close after a late admission advances a sealed source", async () => {
    await seedAuthorityState();
    const [accepted] = await admitAcceptedSet("drain-source-before-late", [3]);
    const source = await sealAcceptedSource([accepted], { pageSize: 1 });
    const command = await drainCloseCommand(accepted, source);
    const [late] = await admitAcceptedSet("drain-source-after-seal", [7]);

    await expect(
      env.DB.prepare(
        `SELECT accepted_sequence
         FROM relay_container_admission_commits
         WHERE operation_id = ?1`,
      )
        .bind(late.operationId)
        .first(),
    ).resolves.toEqual({ accepted_sequence: 2 });
    await expect(drainCloseCommandStatement(command).run()).rejects.toThrow(
      /drain close command requires an exact sealed accepted source/,
    );
    await expect(
      env.DB.prepare(
        `SELECT admission_open, closed_campaign_id
         FROM relay_container_admission_fences
         WHERE admission_fence_id_sha256 = ?1`,
      )
        .bind(admissionFenceId)
        .first(),
    ).resolves.toEqual({ admission_open: 1, closed_campaign_id: null });
  });

  it("rejects close commands with a mismatched sealed digest or manifest", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-command-mismatch", [
      3,
    ]);
    const source = await sealAcceptedSource([intent], { pageSize: 1 });
    const command = await drainCloseCommand(intent, source);

    await expect(
      drainCloseCommandStatement({
        ...command,
        acceptedSetManifestSha256: await sha256Text(
          "mismatched-accepted-set-manifest",
        ),
      }).run(),
    ).rejects.toThrow(
      /drain close command requires a retained successful terminal receipt/,
    );
    await expect(
      drainCloseCommandStatement({
        ...command,
        acceptedSourceReadbackSha256: await sha256Text(
          "mismatched-accepted-source-readback",
        ),
      }).run(),
    ).rejects.toThrow(
      /drain close command requires a retained successful terminal receipt/,
    );
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_drain_close_commands)
             AS commands,
           (SELECT COUNT(*) FROM relay_container_drain_campaigns)
             AS campaigns`,
      ).first(),
    ).resolves.toEqual({ commands: 0, campaigns: 0 });
  });

  it("rejects INSERT OR REPLACE from deleting sealed source history", async () => {
    await seedAuthorityState();
    const [intent] = await admitAcceptedSet("drain-source-replace", [3]);
    const source = await sealAcceptedSource([intent], { pageSize: 1 });

    await expect(
      env.DB.prepare(
        `INSERT OR REPLACE INTO relay_container_drain_source_seals
         SELECT *
         FROM relay_container_drain_source_seals
         WHERE source_seal_id_sha256 = ?1`,
      )
        .bind(source.sourceSealIdSha256)
        .run(),
    ).rejects.toThrow(/drain source seal identity already exists/);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_drain_source_seals
         WHERE source_seal_id_sha256 = ?1`,
      )
        .bind(source.sourceSealIdSha256)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("classifies concurrent equivalents and exact replay through either alias without another debit", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("concurrent", {
      clientIdempotencyHmacAliases: [hex("c"), hex("1")],
    });

    const concurrent = await Promise.all([
      admitOrClassifyExactReplay(intent),
      admitOrClassifyExactReplay(intent),
    ]);
    expect(
      concurrent.map(({ classification }) => classification).sort(),
    ).toEqual(["matching_resumable", "newly_applied"]);
    const applied = concurrent.find(
      ({ classification }) => classification === "newly_applied",
    );
    expect(applied.results).toHaveLength(19);
    expect(applied.results.map((result) => result.meta.changes)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);

    const replay = {
      ...intent,
      clientIdempotencyHmacAliases: [
        ...intent.clientIdempotencyHmacAliases,
      ].reverse(),
    };
    await expect(admitOrClassifyExactReplay(replay)).resolves.toMatchObject({
      classification: "matching_resumable",
      winner: {
        reservationKey: intent.reservationKey,
        operationId: intent.operationId,
      },
    });
    expect(await atomicAdmissionState(intent)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: intent.createdAt,
      },
      channel: { used_quota: 0 },
      counts: {
        reservations: 1,
        operations: 1,
        admissions: 1,
        aliases: 2,
        commits: 1,
      },
    });
  });

  it("serializes reversed current-key versions onto one persisted winner", async () => {
    await seedAuthorityState();
    const oldAlias = hex("1");
    const newAlias = hex("2");
    const requestSha256 = hex("d");
    const versionA = await atomicAdmissionIntent("reversed-old", {
      atomicAdmissionSha256: hex("4"),
      operationAdmissionSha256: hex("6"),
      clientIdempotencyHmacSha256: oldAlias,
      clientIdempotencyHmacAliases: [oldAlias, newAlias],
      clientRequestSha256: requestSha256,
      reconciliationId: hex("8"),
    });
    const versionB = await atomicAdmissionIntent("reversed-new", {
      atomicAdmissionSha256: hex("5"),
      operationAdmissionSha256: hex("7"),
      clientIdempotencyHmacSha256: newAlias,
      clientIdempotencyHmacAliases: [newAlias, oldAlias],
      clientRequestSha256: requestSha256,
      reconciliationId: hex("9"),
    });

    const outcomes = await Promise.all([
      admitOrClassifyExactReplay(versionA),
      admitOrClassifyExactReplay(versionB),
    ]);
    expect(outcomes.map(({ classification }) => classification).sort()).toEqual([
      "matching_resumable",
      "newly_applied",
    ]);
    const applied = outcomes.find(
      ({ classification }) => classification === "newly_applied",
    );
    const loser = outcomes.find(
      ({ classification }) => classification === "matching_resumable",
    );
    expect(applied.results).toHaveLength(19);
    expect(applied.results.map((result) => result.meta.changes)).toEqual([
      0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0,
    ]);
    expect(loser.winner).toEqual(applied.winner);

    const persistedIntent =
      applied.winner.reservationKey === versionA.reservationKey
        ? versionA
        : versionB;
    expect(await atomicAdmissionState(persistedIntent)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: persistedIntent.createdAt,
      },
      channel: { used_quota: 0 },
      counts: {
        reservations: 1,
        operations: 1,
        admissions: 1,
        aliases: 2,
        commits: 1,
      },
    });
    const aliases = await env.DB.prepare(
      `SELECT client_idempotency_hmac_sha256,
              reservation_key, operation_id,
              canonical_client_idempotency_hmac_sha256,
              client_request_sha256
       FROM relay_container_idempotency_aliases
       ORDER BY client_idempotency_hmac_sha256`,
    ).all();
    expect(aliases.results).toEqual(
      [oldAlias, newAlias].sort().map((alias) => ({
        client_idempotency_hmac_sha256: alias,
        reservation_key: applied.winner.reservationKey,
        operation_id: applied.winner.operationId,
        canonical_client_idempotency_hmac_sha256:
          applied.winner.canonicalClientIdempotencyHmacSha256,
        client_request_sha256: requestSha256,
      })),
    );
  });

  it("fails closed on an alias reused for a different request or conflicting reservation identity", async () => {
    await seedAuthorityState();
    const winner = await atomicAdmissionIntent("conflict-winner", {
      clientIdempotencyHmacAliases: [hex("c"), hex("1")],
    });
    await expect(admitOrClassifyExactReplay(winner)).resolves.toMatchObject({
      classification: "newly_applied",
    });
    const before = await atomicAdmissionState(winner);

    const differentRequest = await atomicAdmissionIntent("conflict-request", {
      atomicAdmissionSha256: hex("4"),
      clientIdempotencyHmacSha256: hex("1"),
      clientIdempotencyHmacAliases: [hex("1"), hex("c")],
      clientRequestSha256: hex("3"),
    });
    await expect(
      admitOrClassifyExactReplay(differentRequest),
    ).resolves.toMatchObject({ classification: "request_conflict" });

    const conflictingIdentity = await atomicAdmissionIntent(
      "conflict-identity",
      {
        reservationKey: winner.reservationKey,
        operationId: winner.operationId,
        atomicAdmissionSha256: hex("5"),
        clientIdempotencyHmacSha256: hex("2"),
        clientIdempotencyHmacAliases: [hex("2")],
        clientRequestSha256: winner.clientRequestSha256,
      },
    );
    await expect(
      admitOrClassifyExactReplay(conflictingIdentity),
    ).resolves.toMatchObject({ classification: "immutable_conflict" });
    expect(await atomicAdmissionState(winner)).toEqual(before);
  });

  it("rejects every update and delete of a persisted idempotency alias", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("immutable-alias", {
      clientIdempotencyHmacAliases: [hex("c"), hex("1")],
    });
    await runAtomicAdmissionBatch(intent);
    const alias = intent.clientIdempotencyHmacAliases[1];

    await expect(
      env.DB.prepare(
        `UPDATE relay_container_idempotency_aliases
         SET created_at = created_at
         WHERE client_idempotency_hmac_sha256 = ?1`,
      )
        .bind(alias)
        .run(),
    ).rejects.toThrow(/relay container idempotency alias is immutable/);
    await expect(
      env.DB.prepare(
        `DELETE FROM relay_container_idempotency_aliases
         WHERE client_idempotency_hmac_sha256 = ?1`,
      )
        .bind(alias)
        .run(),
    ).rejects.toThrow(/relay container idempotency alias cannot be deleted/);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM relay_container_idempotency_aliases
         WHERE reservation_key = ?1`,
      )
        .bind(intent.reservationKey)
        .first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("resumes the persisted winner when loser-only time and R2 metadata differ", async () => {
    await seedAuthorityState();
    const winner = await atomicAdmissionIntent("ephemeral-winner");
    await expect(admitOrClassifyExactReplay(winner)).resolves.toMatchObject({
      classification: "newly_applied",
    });
    const loser = {
      ...winner,
      operationAdmissionSha256: hex("6"),
      ownerLeaseExpiresAt: winner.ownerLeaseExpiresAt + 30,
      selectedAt: winner.selectedAt + 5,
      createdAt: winner.createdAt + 5,
      executionDeadlineAt: winner.executionDeadlineAt + 5,
      inputObjectVersion: "atomic-runtime-input-loser",
      traceId: "trace-ephemeral-loser",
    };

    await expect(admitOrClassifyExactReplay(loser)).resolves.toMatchObject({
      classification: "matching_resumable",
    });
    expect(await atomicAdmissionState(winner)).toEqual({
      user: {
        quota: initialUserQuota - reservedQuota,
        used_quota: 0,
        request_count: 0,
      },
      token: {
        remain_quota: initialTokenQuota - reservedQuota,
        used_quota: reservedQuota,
        accessed_time: winner.createdAt,
      },
      channel: { used_quota: 0 },
      counts: {
        reservations: 1,
        operations: 1,
        admissions: 1,
        aliases: 1,
        commits: 1,
      },
    });
  });

  it("allows a marked winner to enter the existing dispatched lifecycle", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("dispatch-compatible");
    await runAtomicAdmissionBatch(intent);

    const result = await env.DB.prepare(
      `UPDATE relay_container_operations
       SET status = 'dispatched', updated_at = ?2
       WHERE operation_id = ?1 AND status = 'prepared'`,
    )
      .bind(intent.operationId, intent.createdAt + 1)
      .run();

    expect(result.meta.changes).toBe(1);
    await expect(
      env.DB.prepare(
        `SELECT status FROM relay_container_operations WHERE operation_id = ?1`,
      )
        .bind(intent.operationId)
        .first(),
    ).resolves.toEqual({ status: "dispatched" });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM relay_container_atomic_admissions
         WHERE operation_id = ?1`,
      )
        .bind(intent.operationId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it.each([
    { aliasCount: 1, aliases: [hex("c")] },
    { aliasCount: 2, aliases: [hex("c"), hex("1")] },
  ])(
    "rolls back the receipt, $aliasCount alias row(s), reservation, operation, and both debits on final mismatch",
    async ({ aliasCount, aliases }) => {
      await seedAuthorityState();
      const intent = await atomicAdmissionIntent(`marker-mismatch-${aliasCount}`, {
        clientIdempotencyHmacAliases: aliases,
      });
      const before = await atomicAdmissionState(intent);

      await expect(
        runAtomicAdmissionBatch(intent, {
          markerOperationAdmissionSha256: hex("0"),
        }),
      ).rejects.toThrow(
        /relay container atomic admission lacks an open D1 fence/,
      );

      expect(await atomicAdmissionState(intent)).toEqual(before);
      expect(before.counts).toEqual({
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      });
    },
  );

  it.each([
    {
      failure: "user quota",
      userQuota: reservedQuota - 1,
      tokenQuota: initialTokenQuota,
    },
    {
      failure: "token quota",
      userQuota: initialUserQuota,
      tokenQuota: reservedQuota - 1,
    },
  ])(
    "rolls back every financial and admission write on $failure failure",
    async ({ failure: _failure, userQuota, tokenQuota }) => {
      await seedAuthorityState({ userQuota, tokenQuota });
      const intent = await atomicAdmissionIntent("quota-failure");
      const before = await atomicAdmissionState(intent);

      await expect(runAtomicAdmissionBatch(intent)).rejects.toThrow();

      expect(await atomicAdmissionState(intent)).toEqual(before);
      expect(before.counts).toEqual({
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      });
    },
  );

  it("rejects a pre-0068 writer before any admission or financial side effect", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("old-writer");
    await expect(
      runAtomicAdmissionBatch(intent, {
        includeAdmissionFenceCommit: false,
        includeResponseArtifactContract: false,
      }),
    ).rejects.toThrow(/relay container atomic admission lacks an open D1 fence/);

    expect(await atomicAdmissionState(intent)).toMatchObject({
      counts: {
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      },
      user: { quota: initialUserQuota },
      token: { remain_quota: initialTokenQuota, used_quota: 0 },
    });
  });

  it("rejects an unfenced future operation kind and protocol", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("future-writer");

    await expect(
      env.DB.batch([
        env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
        selectedReservationStatement(intent),
        preparedOperationStatement(intent, {
          operationKind: "future_container_dispatch",
          protocolVersion: 2,
        }),
      ]),
    ).rejects.toThrow(/relay container operation lacks an open D1 fence/);
    expect(await atomicAdmissionState(intent)).toMatchObject({
      counts: {
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      },
    });
  });

  it("keeps the response-artifact writer upgrade mandatory inside a fenced batch", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("old-response-artifact-writer");

    await expect(
      runAtomicAdmissionBatch(intent, {
        includeResponseArtifactContract: false,
      }),
    ).rejects.toThrow(
      /relay container response artifact writer contract is required/,
    );
    expect(await atomicAdmissionState(intent)).toMatchObject({
      counts: {
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      },
    });
  });

  it("rejects a stale fence generation and rolls back the commit sidecar", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("stale-fence", {
      fenceGeneration: 2,
    });

    await expect(runAtomicAdmissionBatch(intent)).rejects.toThrow(
      /relay container admission fence is closed or stale/,
    );
    expect(await atomicAdmissionState(intent)).toMatchObject({
      counts: {
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      },
      user: { quota: initialUserQuota },
      token: { remain_quota: initialTokenQuota, used_quota: 0 },
    });
  });

  it("rechecks user, token, and channel authority inside the atomic batch", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("authority-change");

    for (const mutation of [
      "UPDATE users SET status = 2 WHERE id = 501",
      "UPDATE tokens SET status = 2 WHERE id = 502",
      "UPDATE channels SET status = 2 WHERE id = 503",
    ]) {
      await env.DB.prepare(mutation).run();
      await expect(runAtomicAdmissionBatch(intent)).rejects.toThrow();
      expect((await atomicAdmissionState(intent)).counts).toEqual({
        reservations: 0,
        operations: 0,
        admissions: 0,
        aliases: 0,
        commits: 0,
      });
      await env.DB.prepare("UPDATE users SET status = 1 WHERE id = 501").run();
      await env.DB.prepare("UPDATE tokens SET status = 1 WHERE id = 502").run();
      await env.DB.prepare(
        "UPDATE channels SET status = 1 WHERE id = 503",
      ).run();
    }
  });
});

describe("migration 0051 scheduled relay Container terminalization", () => {
  it("rolls back the full financial terminal batch on a stale observer and commits once with the active lease", async () => {
    await seedAuthorityState();
    const intent = await atomicAdmissionIntent("scheduled-terminalization");
    await runAtomicAdmissionBatch(intent);
    const terminal = await prepareScheduledTerminalization(intent);

    await expect(
      runScheduledTerminalizationBatch(intent, terminal, {
        claimOwner: "b".repeat(32),
      }),
    ).rejects.toThrow(
      /relay container scheduled terminalization fence is invalid/,
    );
    await expect(
      runScheduledTerminalizationBatch(intent, terminal, {
        claimLeaseExpiresAt: terminal.claimLeaseExpiresAt + 1,
      }),
    ).rejects.toThrow(
      /relay container scheduled terminalization fence is invalid/,
    );
    await expect(scheduledTerminalizationState(intent, terminal)).resolves.toEqual({
      operation: { status: "dispatched", response_status: null },
      reservation: {
        status: "reserved",
        owner_generation: 2,
        final_quota: 0,
        request_accounted: 0,
      },
      user: { quota: 875, used_quota: 0, request_count: 0 },
      token: { remain_quota: 375, used_quota: 125 },
      channel: { used_quota: 0 },
      counts: { events: 0, outbox: 0, terminalizations: 0 },
    });

    const results = await runScheduledTerminalizationBatch(intent, terminal);
    expect(results).toHaveLength(9);
    expect(results.map((result) => result.meta.changes)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1,
    ]);
    await expect(scheduledTerminalizationState(intent, terminal)).resolves.toEqual({
      operation: { status: "completed", response_status: 200 },
      reservation: {
        status: "settled",
        owner_generation: 3,
        final_quota: 80,
        request_accounted: 1,
      },
      user: { quota: 920, used_quota: 80, request_count: 1 },
      token: { remain_quota: 420, used_quota: 80 },
      channel: { used_quota: 80 },
      counts: { events: 1, outbox: 1, terminalizations: 1 },
    });

    await expect(
      runScheduledTerminalizationBatch(intent, terminal),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `UPDATE relay_container_scheduled_terminalizations
         SET committed_at = committed_at + 1
         WHERE billing_event_id = ?1`,
      )
        .bind(terminal.billingEventId)
        .run(),
    ).rejects.toThrow(/scheduled terminalization is immutable/);
    await expect(
      env.DB.prepare(
        `DELETE FROM relay_container_scheduled_terminalizations
         WHERE billing_event_id = ?1`,
      )
        .bind(terminal.billingEventId)
        .run(),
    ).rejects.toThrow(/scheduled terminalization cannot be deleted/);
  });
});

async function prepareScheduledTerminalization(intent) {
  const observationCreatedAt = intent.createdAt + 301;
  const claimAt = observationCreatedAt + 1;
  const terminalAt = claimAt + 1;
  const claimLeaseExpiresAt = claimAt + 60;
  const claimOwner = "a".repeat(32);
  const resultSha256 = hex("7");
  const usageReceiptSha256 = hex("8");
  const clientResponseSha256 = hex("9");
  const headersJson = '{"content-type":"application/json"}';
  const outboxPayloadJson = "{}";

  await env.DB.prepare(
    `UPDATE relay_container_operations
     SET status = 'dispatched', updated_at = ?2
     WHERE operation_id = ?1 AND status = 'prepared'`,
  )
    .bind(intent.operationId, intent.createdAt + 1)
    .run();
  await env.DB.prepare(
    `INSERT INTO relay_container_reconciliation_observations (
       operation_id, reservation_key, operation_created_at,
       owner_generation, reconciliation_id, status, available_at,
       recovery_deadline_at, created_at, updated_at
     ) VALUES (?1, ?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?5, ?5)`,
  )
    .bind(
      intent.operationId,
      intent.createdAt,
      intent.ownerGeneration,
      intent.reconciliationId,
      observationCreatedAt,
      observationCreatedAt + 86_400,
    )
    .run();
  await env.DB.prepare(
    `UPDATE relay_container_reconciliation_observations
     SET status = 'leased', claim_generation = 1, claim_owner = ?2,
         claim_lease_expires_at = ?4, available_at = 0, attempt_count = 1,
         first_observed_at = ?3, last_attempt_at = ?3, updated_at = ?3
     WHERE operation_id = ?1`,
  )
    .bind(intent.operationId, claimOwner, claimAt, claimLeaseExpiresAt)
    .run();

  // This suite isolates the 0051 financial batch fence. The 0048 receipt,
  // 0052 response-artifact, and 0053 financial-terminal-v2 guards have their
  // own full-schema coverage and require the complete egress/evidence fixture
  // before this legacy terminal batch can be staged.
  await env.DB.batch([
    env.DB.prepare(
      "DROP TRIGGER relay_container_terminal_event_provider_usage_guard",
    ),
    env.DB.prepare(
      "DROP TRIGGER relay_container_terminal_event_response_artifact_guard",
    ),
    env.DB.prepare(
      "DROP TRIGGER relay_container_scheduled_terminalization_response_artifact_guard",
    ),
    env.DB.prepare("DROP TRIGGER relay_container_financial_terminal_v2_guard"),
  ]);

  return {
    billingEventId: hex("5"),
    claimGeneration: 1,
    claimLeaseExpiresAt,
    claimOwner,
    clientResponseObjectKey:
      `container-client-responses/v1/${intent.operationId}/2/${clientResponseSha256}`,
    clientResponseSha256,
    clientResponseVersion: "scheduled-client-response-v1",
    finalQuota: 80,
    headersJson,
    headersSha256: await sha256Text(headersJson),
    outboxPayloadJson,
    outboxPayloadSha256: await sha256Text(outboxPayloadJson),
    resultObjectKey:
      `container-results/v1/${intent.operationId}/2/${resultSha256}`,
    resultObjectVersion: "scheduled-provider-result-v1",
    resultSha256,
    terminalAt,
    terminalContractSha256: hex("4"),
    usageReceiptSha256,
  };
}

async function runScheduledTerminalizationBatch(
  intent,
  terminal,
  {
    claimOwner = terminal.claimOwner,
    claimLeaseExpiresAt = terminal.claimLeaseExpiresAt,
  } = {},
) {
  const quotaCredit = intent.preConsumedQuota - terminal.finalQuota;
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO relay_container_terminal_events (
         billing_event_id, reservation_key, operation_id, owner_generation,
         operation_from_status, operation_status, terminal_contract_sha256,
         billing_action, billing_owner_generation, billing_from_status,
         billing_final_quota, billing_request_accounted, billing_reason,
         pre_consumed_quota, user_quota_delta, token_quota_delta,
         user_used_quota_delta, channel_used_quota_delta, request_count_delta,
         reconciliation_id, reconciliation_revision, client_response_status,
         client_response_headers_json, client_response_headers_sha256,
         client_response_object_key, client_response_object_version,
         client_response_sha256, client_response_size,
         client_response_content_type, outbox_schema_version,
         outbox_payload_json, outbox_payload_sha256, created_at,
         provider_usage_receipt_sha256, provider_result_sha256,
         provider_attempt_generation
       ) VALUES (
         ?1, ?2, ?2, ?3, 'dispatched', 'completed', ?4, 'settle', ?3,
         'reserved', ?5, 1, 'container_provider_usage_settlement', ?6,
         ?7, ?7, ?5, ?5, 1, ?8, 1, 200, ?9, ?10, ?11, ?12, ?13, 2,
         'application/json', 1, ?14, ?15, ?16, ?17, ?18, 1
       )`,
    ).bind(
      terminal.billingEventId,
      intent.operationId,
      intent.ownerGeneration,
      terminal.terminalContractSha256,
      terminal.finalQuota,
      intent.preConsumedQuota,
      quotaCredit,
      intent.reconciliationId,
      terminal.headersJson,
      terminal.headersSha256,
      terminal.clientResponseObjectKey,
      terminal.clientResponseVersion,
      terminal.clientResponseSha256,
      terminal.outboxPayloadJson,
      terminal.outboxPayloadSha256,
      terminal.terminalAt,
      terminal.usageReceiptSha256,
      terminal.resultSha256,
    ),
    env.DB.prepare(
      `INSERT INTO relay_container_terminal_outbox_state (
         billing_event_id, status, delivery_generation, delivery_attempt_count,
         lease_expires_at, available_at, delivered_at, last_error,
         created_at, updated_at
       ) VALUES (?1, 'pending', 0, 0, 0, ?2, 0, '', ?2, ?2)`,
    ).bind(terminal.billingEventId, terminal.terminalAt),
    env.DB.prepare(
      `UPDATE relay_container_operations
       SET status = 'completed', response_status = 200, response_code = NULL,
           result_object_key = ?2, result_object_version = ?3,
           result_sha256 = ?4, result_size = 2,
           result_content_type = 'application/json', updated_at = ?5
       WHERE operation_id = ?1 AND reservation_key = ?1
         AND owner_generation = ?6 AND status = 'dispatched'`,
    ).bind(
      intent.operationId,
      terminal.resultObjectKey,
      terminal.resultObjectVersion,
      terminal.resultSha256,
      terminal.terminalAt,
      intent.ownerGeneration,
    ),
    env.DB.prepare(
      `UPDATE relay_billing_reservations
       SET status = 'settled', owner_generation = owner_generation + 1,
           final_quota = ?2,
           finalization_reason = 'container_provider_usage_settlement',
           request_accounted = 1, settled_at = ?3, updated_at = ?3
       WHERE reservation_key = ?1 AND owner_generation = ?4
         AND status = 'reserved'`,
    ).bind(
      intent.reservationKey,
      terminal.finalQuota,
      terminal.terminalAt,
      intent.ownerGeneration,
    ),
    env.DB.prepare("UPDATE users SET quota = quota + ?1 WHERE id = ?2").bind(
      quotaCredit,
      userId,
    ),
    env.DB.prepare(
      `UPDATE tokens
       SET remain_quota = remain_quota + ?1,
           used_quota = MAX(used_quota - ?1, 0), accessed_time = ?2
       WHERE id = ?3`,
    ).bind(quotaCredit, terminal.terminalAt, tokenId),
    env.DB.prepare(
      `UPDATE users
       SET used_quota = used_quota + ?1, request_count = request_count + 1
       WHERE id = ?2`,
    ).bind(terminal.finalQuota, userId),
    env.DB.prepare(
      "UPDATE channels SET used_quota = used_quota + ?1 WHERE id = ?2",
    ).bind(terminal.finalQuota, channelId),
    env.DB.prepare(
      `INSERT INTO relay_container_scheduled_terminalizations (
         billing_event_id, reservation_key, operation_id, owner_generation,
         operation_from_status, billing_owner_generation, reconciliation_id,
         reconciliation_revision, observation_claim_generation,
         observation_claim_owner, observation_claim_lease_expires_at,
         decision, provider_usage_receipt_sha256, provider_result_sha256,
         terminal_contract_sha256, committed_at, created_at
       ) VALUES (
         ?1, ?2, ?2, ?3, 'dispatched', ?3, ?4, 1, ?5, ?6, ?7, 'settle',
         ?8, ?9, ?10, ?11, ?11
       )`,
    ).bind(
      terminal.billingEventId,
      intent.operationId,
      intent.ownerGeneration,
      intent.reconciliationId,
      terminal.claimGeneration,
      claimOwner,
      claimLeaseExpiresAt,
      terminal.usageReceiptSha256,
      terminal.resultSha256,
      terminal.terminalContractSha256,
      terminal.terminalAt,
    ),
  ]);
}

async function scheduledTerminalizationState(intent, terminal) {
  const [operation, reservation, user, token, channel, counts] =
    await Promise.all([
      env.DB.prepare(
        `SELECT status, response_status
         FROM relay_container_operations WHERE operation_id = ?1`,
      )
        .bind(intent.operationId)
        .first(),
      env.DB.prepare(
        `SELECT status, owner_generation, final_quota, request_accounted
         FROM relay_billing_reservations WHERE reservation_key = ?1`,
      )
        .bind(intent.reservationKey)
        .first(),
      env.DB.prepare(
        "SELECT quota, used_quota, request_count FROM users WHERE id = ?1",
      )
        .bind(userId)
        .first(),
      env.DB.prepare(
        "SELECT remain_quota, used_quota FROM tokens WHERE id = ?1",
      )
        .bind(tokenId)
        .first(),
      env.DB.prepare("SELECT used_quota FROM channels WHERE id = ?1")
        .bind(channelId)
        .first(),
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM relay_container_terminal_events
            WHERE operation_id = ?1) AS events,
           (SELECT COUNT(*) FROM relay_container_terminal_outbox_state
            WHERE billing_event_id = ?2) AS outbox,
           (SELECT COUNT(*) FROM relay_container_scheduled_terminalizations
            WHERE billing_event_id = ?2) AS terminalizations`,
      )
        .bind(intent.operationId, terminal.billingEventId)
        .first(),
    ]);
  return { operation, reservation, user, token, channel, counts };
}

async function seedAuthorityState({
  userQuota = initialUserQuota,
  tokenQuota = initialTokenQuota,
} = {}) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
        (id, username, password, quota, used_quota, request_count)
       VALUES (?1, 'atomic-runtime-user', 'disabled', ?2, 0, 0)`,
    ).bind(userId, userQuota),
    env.DB.prepare(
      `INSERT INTO tokens
        (id, user_id, "key", status, name, created_time, accessed_time,
         expired_time, remain_quota, unlimited_quota, used_quota, "group")
       VALUES (?1, ?2, ?3, 1, 'atomic runtime token', 1, 0, -1, ?4, 0, 0,
         'default')`,
    ).bind(tokenId, userId, hex("8"), tokenQuota),
    env.DB.prepare(
      `INSERT INTO channels
        (id, type, "key", name, status, "group", models, used_quota)
       VALUES (?1, 1, ?2, 'atomic runtime channel', 1, 'default',
         'gpt-atomic-runtime', 0)`,
    ).bind(channelId, hex("9")),
    env.DB.prepare(
      `INSERT INTO abilities
        (id, group_name, model, channel_id, enabled, priority, weight)
       VALUES (504, 'default', 'gpt-atomic-runtime', ?1, 1, 0, 0)`,
    ).bind(channelId),
  ]);
}

async function seedAdmissionFence() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO relay_container_admission_fences (
         admission_fence_id_sha256, contract_version, fence_contract,
         fence_kind, environment, scope_kind, scope_id_sha256,
         fence_generation, admission_open, state_digest_sha256,
         created_by_admin_id, created_at
       ) VALUES (
         ?1, 1, 'relay-container-admission-fence-v1', 'admission',
         'staging', 'global', ?2, 1, 1, ?3, 42, unixepoch()
       )`,
    ).bind(admissionFenceId, admissionScopeId, hex("7")),
    env.DB.prepare(
      `INSERT INTO relay_container_admission_scope_heads (
         environment, scope_kind, scope_id_sha256, current_fence_id_sha256,
         current_fence_generation, head_version, head_digest_sha256,
         updated_by_admin_id, updated_at
       ) VALUES (
         'staging', 'global', ?1, ?2, 1, 1, ?3, 42, unixepoch()
       )`,
    ).bind(admissionScopeId, admissionFenceId, hex("8")),
  ]);
}

async function atomicAdmissionIntent(suffix, overrides = {}) {
  const operationId =
    overrides.operationId ?? `relaycontainer-atomic-runtime-${suffix}`;
  const reservationKey = overrides.reservationKey ?? operationId;
  const createdAt = overrides.createdAt ?? 2_000_000_000;
  const ownerLeaseExpiresAt =
    overrides.ownerLeaseExpiresAt ?? createdAt + 600;
  const operationAdmissionSha256 =
    overrides.operationAdmissionSha256 ?? hex("a");
  const inputSha256 = overrides.inputSha256 ?? hex("f");
  const clientIdempotencyHmacSha256 =
    overrides.clientIdempotencyHmacSha256 ?? hex("c");
  const clientIdempotencyHmacAliases = [
    ...(overrides.clientIdempotencyHmacAliases ?? [
      clientIdempotencyHmacSha256,
    ]),
  ];
  const billingSnapshotJson =
    overrides.billingSnapshotJson ??
    JSON.stringify({
      billing_mode: "flat",
      model_name: "gpt-atomic-runtime",
      model_price: reservedQuota,
    });
  const intent = {
    reservationKey,
    operationId,
    contractVersion: 1,
    atomicAdmissionSha256: hex("b"),
    operationAdmissionSha256,
    clientIdempotencyHmacSha256,
    clientIdempotencyHmacAliases,
    clientRequestSha256: hex("d"),
    idempotencyAliasCount: clientIdempotencyHmacAliases.length,
    idempotencyAliasesSha256: await idempotencyAliasesSha256(
      clientIdempotencyHmacAliases,
    ),
    billingSnapshotSha256: await sha256Text(billingSnapshotJson),
    reconciliationId: hex("e"),
    environment: "staging",
    scopeKind: "global",
    scopeIdSha256: admissionScopeId,
    admissionFenceIdSha256: admissionFenceId,
    fenceGeneration: 1,
    ownerGeneration: 2,
    ringGeneration: 1,
    shardCount: 8,
    shardIndex: 3,
    ownerLeaseExpiresAt,
    channelId,
    selectedChannelType: 1,
    selectedGroup: "default",
    selectedSnapshotKey: "1",
    selectedAt: createdAt,
    createdAt,
    executionDeadlineAt: createdAt + 300,
    modelName: "gpt-atomic-runtime",
    preConsumedQuota: reservedQuota,
    billingSnapshotJson,
    providerOperationId: `provider-${operationId}`,
    inputSha256,
    inputObjectKey: `container-inputs/v1/${operationId}/2/${inputSha256}`,
    inputObjectVersion: "atomic-runtime-input-v1",
    traceId: `trace-${suffix}`,
    ...overrides,
    clientIdempotencyHmacAliases,
    idempotencyAliasCount: clientIdempotencyHmacAliases.length,
    idempotencyAliasesSha256: await idempotencyAliasesSha256(
      clientIdempotencyHmacAliases,
    ),
  };
  return {
    ...intent,
    admissionCommitSha256:
      overrides.admissionCommitSha256 ??
      (await relayContainerAdmissionCommitSha256(intent)),
  };
}

async function runAtomicAdmissionBatch(
  intent,
  {
    markerOperationAdmissionSha256 = intent.operationAdmissionSha256,
    includeResponseArtifactContract = true,
    includeAdmissionFenceCommit = true,
  } = {},
) {
  return env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ...(includeAdmissionFenceCommit
      ? [admissionCommitStatement(intent), previousChangeAssertion(intent)]
      : []),
    atomicAdmissionStatement(intent, markerOperationAdmissionSha256),
    previousChangeAssertion(intent),
    ...intent.clientIdempotencyHmacAliases.flatMap((alias) => [
      idempotencyAliasStatement(intent, alias),
      previousChangeAssertion(intent),
    ]),
    selectedReservationStatement(intent),
    previousChangeAssertion(intent),
    userDebitStatement(intent),
    previousChangeAssertion(intent),
    tokenDebitStatement(intent),
    previousChangeAssertion(intent),
    channelAuthorityStatement(intent),
    previousChangeAssertion(intent),
    preparedOperationStatement(intent, { includeResponseArtifactContract }),
    previousChangeAssertion(intent),
  ]);
}

async function admitAcceptedSet(suffix, shardIndexes) {
  const intents = [];
  for (const [index, shardIndex] of shardIndexes.entries()) {
    const seed = `relay-container-source-runtime:${suffix}:${index + 1}`;
    const clientIdempotencyHmacSha256 = await sha256Text(`${seed}:alias`);
    const intent = await atomicAdmissionIntent(`${suffix}-${index + 1}`, {
      atomicAdmissionSha256: await sha256Text(`${seed}:atomic-admission`),
      operationAdmissionSha256: await sha256Text(
        `${seed}:operation-admission`,
      ),
      clientIdempotencyHmacSha256,
      clientIdempotencyHmacAliases: [clientIdempotencyHmacSha256],
      clientRequestSha256: await sha256Text(`${seed}:client-request`),
      reconciliationId: await sha256Text(`${seed}:reconciliation`),
      inputSha256: await sha256Text(`${seed}:input`),
      shardIndex,
    });
    await runAtomicAdmissionBatch(intent);
    intents.push(intent);
  }
  return intents;
}

async function prepareAcceptedSource(
  intents,
  {
    pageSize,
    omittedPageOrdinals = [],
    omittedShardIndexes = [],
    includeClaim = true,
    claimAuthorization = null,
    collectSource = true,
  },
) {
  const commitResult = await env.DB.prepare(
    `SELECT accepted_sequence, operation_id, source_contract,
            admission_fence_id_sha256, fence_generation, reservation_key,
            atomic_admission_sha256, operation_admission_sha256,
            billing_snapshot_sha256, client_request_sha256,
            owner_generation, ring_generation,
            shard_count AS source_shard_count, shard_index,
            admission_commit_sha256, committed_at
     FROM relay_container_admission_commits
     WHERE scope_kind = 'global' AND scope_id_sha256 = ?1
     ORDER BY accepted_sequence`,
  )
    .bind(admissionScopeId)
    .all();
  const commits = commitResult.results;
  expect(commits).toHaveLength(intents.length);
  expect(commits.length).toBeGreaterThan(0);

  const fixtureKey = intents.map(({ operationId }) => operationId).join(":");
  const digest = (field) =>
    sha256Text(`relay-container-drain-source:${fixtureKey}:${field}`);
  const d1Clock = await env.DB.prepare("SELECT unixepoch() AS now").first();
  const source = {
    authorizationIdSha256: await digest("authorization-id"),
    sourceScanIdSha256: await digest("scan-id"),
    capturedHighWatermark: commits.at(-1).accepted_sequence,
    capturedMemberCount: commits.length,
    capturedFirstSequence: commits[0].accepted_sequence,
    capturedFirstOperationId: commits[0].operation_id,
    capturedLastSequence: commits.at(-1).accepted_sequence,
    capturedLastOperationId: commits.at(-1).operation_id,
    pageSize,
    shardCount: commits[0].source_shard_count,
    acceptedBookmarkSha256: await digest("bookmark"),
    acceptedSetManifestSha256: await digest("accepted-set-manifest"),
    acceptedSourceSchemaSha256,
    acceptedSourceReadbackSha256: await digest("source-readback"),
    shardSetManifestSha256: await digest("shard-set-manifest"),
    sourceSealIdSha256: await digest("seal-id"),
    rootAdminId: 42,
    rootSessionEpoch: 7,
    passkeyCredentialRowId: 42073,
    rootSessionBindingSha256: await digest("root-session-binding"),
    passkeyCredentialIdSha256: await digest("passkey-credential"),
    passkeyAssertionSubjectSha256: await digest("passkey-assertion-subject"),
    passkeyAssertionSignatureSha256: await digest(
      "passkey-assertion-signature",
    ),
    secureVerificationChallengeSha256: await digest(
      "secure-verification-challenge",
    ),
    secureVerificationReceiptSha256: await digest(
      "secure-verification-receipt",
    ),
    actionDigestSha256: await digest("registration-action"),
    adminAuditDigestSha256: await digest("admin-audit"),
    changeTicketSha256: await digest("change-ticket"),
    registrationExecutionIdSha256: await digest("registration-execution"),
    registrationCredentialIdSha256: await digest(
      "registration-credential",
    ),
    registrationRequestSha256: await digest("registration-request"),
    registrationReceiptSha256: await digest("registration-receipt"),
    claimIdSha256: await digest("claim-id"),
    claimRequestSha256: await digest("claim-request"),
    claimDigestSha256: await digest("claim-receipt"),
    terminalActorExecutionIdSha256: await digest("terminal-execution"),
    terminalCredentialIdSha256: await digest("terminal-credential"),
    terminalObservationSha256: await digest("terminal-observation"),
    terminalReceiptSha256: await digest("terminal-receipt"),
    evidenceManifestSha256: await digest("evidence-manifest"),
    evidenceObjectVersionSha256: await digest("evidence-object-version"),
    evidenceObjectEtagSha256: await digest("evidence-object-etag"),
    evidenceContentSha256: await digest("evidence-content"),
    retentionPolicySha256: await digest("retention-policy"),
    authorizerIdentitySha256: await digest("authorizer-identity"),
    authorizerSpkiSha256: await digest("authorizer-spki"),
    authorizationSubjectSha256: await digest("authorization-subject"),
    authorizationSignatureEnvelopeSha256: await digest(
      "authorization-signature",
    ),
    executionNonceSha256: await digest("execution-nonce"),
    assemblerIdentitySha256: await digest("assembler-identity"),
    assemblerSpkiSha256: await digest("assembler-spki"),
    assemblerAttestationSubjectSha256: await digest("assembler-subject"),
    assemblerSignatureEnvelopeSha256: await digest("assembler-signature"),
    verifierIdentitySha256: await digest("verifier-identity"),
    verifierSpkiSha256: await digest("verifier-spki"),
    verifierAttestationSubjectSha256: await digest("verifier-subject"),
    verifierSignatureEnvelopeSha256: await digest("verifier-signature"),
    sealDigestSha256: await digest("seal-digest"),
    collectorRunIdSha256: await digest("collector-run"),
    collectorCredentialIdSha256: await digest("collector-credential"),
    permitIssuedAt: d1Clock.now,
    permitExpiresAt: d1Clock.now + 300,
    claimLeaseExpiresAt: d1Clock.now + 240,
  };

  await env.DB.prepare(
    `INSERT INTO users (
       id, username, password, display_name, role, status, session_epoch,
       aff_code
     ) VALUES (?1, 'root-runtime-42', 'not-a-live-password',
       'Root Runtime 42', 100, 1, ?2, 'runtime-aff-0073')`,
  )
    .bind(source.rootAdminId, source.rootSessionEpoch)
    .run();
  await env.DB.prepare(
    `INSERT INTO passkey_credentials (
       id, user_id, credential_id, public_key, clone_warning,
       user_present, user_verified, last_used_at, created_at, updated_at
     ) VALUES (
       ?1, ?2, 'base64url-runtime-passkey-0073',
       'base64url-runtime-public-key-0073', 0, 1, 1, ?3, ?4, ?3
     )`,
  )
    .bind(
      source.passkeyCredentialRowId,
      source.rootAdminId,
      source.permitIssuedAt,
      source.permitIssuedAt - 100,
    )
    .run();

  const authorizationStatement = env.DB.prepare(
    `INSERT INTO relay_container_drain_source_authorizations (
       authorization_id_sha256, contract_version,
       authorization_contract, authorization_migration,
       environment, scope_kind, scope_id_sha256,
       admission_fence_id_sha256, fence_generation,
       expected_fence_state_digest_sha256, expected_head_version,
       expected_head_digest_sha256, source_scan_id_sha256,
       collector_service_name, collector_version_id,
       collector_run_id_sha256, started_by_credential_id_sha256,
       page_size, shard_count, accepted_source_schema_sha256,
       authorizer_issuer, authorizer_key_id,
       authorizer_identity_sha256, authorizer_spki_sha256,
       authorization_subject_sha256,
       authorization_signature_envelope_sha256,
       execution_nonce_sha256, permit_issued_at, permit_expires_at,
       authorized_by_admin_id
     ) VALUES (
       ?1, 1, 'relay-container-drain-source-authorization-v1',
       '0072_relay_container_drain_source_authorization.sql',
       'staging', 'global', ?2, ?3, 1, ?4, 1, ?5, ?6,
       'relay-source-collector', 'runtime-test-v1', ?7, ?8, ?9, ?10,
       ?11, 'cinatoken-drain-source-authorizer',
       'drain-source-authorizer-v1', ?12, ?13, ?14, ?15, ?16,
       ?17, ?18, ?19
     )`,
  )
    .bind(
      source.authorizationIdSha256,
      admissionScopeId,
      admissionFenceId,
      hex("7"),
      hex("8"),
      source.sourceScanIdSha256,
      source.collectorRunIdSha256,
      source.collectorCredentialIdSha256,
      source.pageSize,
      source.shardCount,
      source.acceptedSourceSchemaSha256,
      source.authorizerIdentitySha256,
      source.authorizerSpkiSha256,
      source.authorizationSubjectSha256,
      source.authorizationSignatureEnvelopeSha256,
      source.executionNonceSha256,
      source.permitIssuedAt,
      source.permitExpiresAt,
      source.rootAdminId,
    );
  const auditStatement = env.DB.prepare(
    `INSERT INTO logs (
       user_id, created_at, type, content, username, ip, request_id, other
     ) VALUES (
       ?1, unixepoch(), 3,
       'registered runtime drain source authorization',
       'root-runtime-42', '192.0.2.73', ?2, ?3
     )`,
  ).bind(
    source.rootAdminId,
    source.adminAuditDigestSha256,
    JSON.stringify({
      op: {
        action: "relay_container.drain_source_authorization_register",
        params: {
          authorization_id_sha256: source.authorizationIdSha256,
          action_digest_sha256: source.actionDigestSha256,
        },
      },
      admin_info: {
        admin_id: source.rootAdminId,
        admin_username: "root-runtime-42",
        admin_role: 100,
        auth_method: "passkey",
      },
    }),
  );
  const registrationStatement = env.DB.prepare(
    `INSERT INTO relay_container_drain_source_authorization_registrations (
       authorization_id_sha256, contract_version,
       registration_contract, registration_migration,
       environment, scope_kind, scope_id_sha256, source_scan_id_sha256,
       root_admin_id, root_session_epoch, root_session_binding_sha256,
       passkey_credential_row_id, passkey_credential_id_sha256,
       passkey_assertion_subject_sha256,
       passkey_assertion_signature_sha256,
       secure_verification_challenge_sha256,
       secure_verification_receipt_sha256, action_digest_sha256,
       admin_audit_digest_sha256, change_ticket_sha256, reason_code,
       registered_by_service_name, registered_by_version_id,
       registration_execution_id_sha256,
       registration_credential_id_sha256,
       registration_request_sha256, authority_ledger_identity_sha256,
       receipt_sequence, ledger_head_before_sha256,
       registration_receipt_sha256, verified_at,
       verification_expires_at
     ) VALUES (
       ?1, 1,
       'relay-container-drain-source-authorization-registration-v1',
       '0073_relay_container_drain_source_authorization_consumption.sql',
       'staging', 'global', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
       ?11, ?12, ?13, ?14, ?15, 'runtime-source-collection',
       'cinatoken-application-worker', 'runtime-test-v1', ?16, ?17,
       ?18, ?2, 1, ?19, ?20, ?21, ?22
     )`,
  ).bind(
    source.authorizationIdSha256,
    admissionScopeId,
    source.sourceScanIdSha256,
    source.rootAdminId,
    source.rootSessionEpoch,
    source.rootSessionBindingSha256,
    source.passkeyCredentialRowId,
    source.passkeyCredentialIdSha256,
    source.passkeyAssertionSubjectSha256,
    source.passkeyAssertionSignatureSha256,
    source.secureVerificationChallengeSha256,
    source.secureVerificationReceiptSha256,
    source.actionDigestSha256,
    source.adminAuditDigestSha256,
    source.changeTicketSha256,
    source.registrationExecutionIdSha256,
    source.registrationCredentialIdSha256,
    source.registrationRequestSha256,
    hex("8"),
    source.registrationReceiptSha256,
    source.permitIssuedAt,
    source.permitIssuedAt + 120,
  );
  const claimStatement = env.DB.prepare(
    `INSERT INTO relay_container_drain_source_authorization_claims (
       authorization_id_sha256, contract_version, claim_contract,
       claim_migration, authority_ledger_identity_sha256,
       registration_receipt_sha256, execution_nonce_sha256,
       claim_id_sha256, claim_request_sha256,
       predecessor_receipt_sha256, receipt_sequence,
       claim_digest_sha256, claim_owner_service_name,
       claim_owner_version_id, claim_owner_execution_id_sha256,
       claim_credential_id_sha256, lease_expires_at
     ) VALUES (
       ?1, 1, 'relay-container-drain-source-authorization-claim-v1',
       '0073_relay_container_drain_source_authorization_consumption.sql',
       ?2, ?3, ?4, ?5, ?6, ?3, 2, ?7,
       'relay-source-collector', 'runtime-test-v1', ?8, ?9, ?10
     )`,
  ).bind(
    source.authorizationIdSha256,
    admissionScopeId,
    source.registrationReceiptSha256,
    source.executionNonceSha256,
    source.claimIdSha256,
    source.claimRequestSha256,
    source.claimDigestSha256,
    source.collectorRunIdSha256,
    source.collectorCredentialIdSha256,
    source.claimLeaseExpiresAt,
  );
  await env.DB.batch([
    authorizationStatement,
    auditStatement,
    registrationStatement,
    ...(includeClaim ? [claimStatement] : []),
  ]);
  if (claimAuthorization !== null) {
    await claimAuthorization(source);
  }
  if (!collectSource) {
    return source;
  }

  await env.DB.prepare(
    `INSERT INTO relay_container_drain_source_scans (
       source_scan_id_sha256, contract_version, scan_contract,
       scan_migration, environment, scope_kind, scope_id_sha256,
       admission_fence_id_sha256, fence_generation,
       expected_fence_state_digest_sha256, expected_head_version,
       expected_head_digest_sha256, captured_high_watermark,
       captured_member_count, captured_first_sequence,
       captured_first_operation_id, captured_last_sequence,
       captured_last_operation_id, page_size, shard_count,
       collector_service_name, collector_version_id,
       collector_run_id_sha256, started_by_credential_id_sha256
     ) VALUES (
       ?1, 1, 'relay-container-drain-source-scan-v1',
       '0071_relay_container_drain_accepted_set_source_seal.sql',
       'staging', 'global', ?2, ?3, 1, ?4, 1, ?5, ?6, ?7, ?8, ?9,
       ?10, ?11, ?12, ?13, 'relay-source-collector', 'runtime-test-v1',
       ?14, ?15
     )`,
  )
    .bind(
      source.sourceScanIdSha256,
      admissionScopeId,
      admissionFenceId,
      hex("7"),
      hex("8"),
      source.capturedHighWatermark,
      source.capturedMemberCount,
      source.capturedFirstSequence,
      source.capturedFirstOperationId,
      source.capturedLastSequence,
      source.capturedLastOperationId,
      source.pageSize,
      source.shardCount,
      source.collectorRunIdSha256,
      source.collectorCredentialIdSha256,
    )
    .run();
  const scanClock = await env.DB.prepare(
    `SELECT started_at
     FROM relay_container_drain_source_scans
     WHERE source_scan_id_sha256 = ?1`,
  )
    .bind(source.sourceScanIdSha256)
    .first();
  expect(scanClock).not.toBeNull();

  for (const commit of commits) {
    const pageOrdinal =
      Math.floor((commit.accepted_sequence - 1) / pageSize) + 1;
    const memberOrdinal = ((commit.accepted_sequence - 1) % pageSize) + 1;
    await env.DB.prepare(
      `INSERT INTO relay_container_drain_source_members (
         source_scan_id_sha256, accepted_sequence, operation_id,
         source_contract, admission_fence_id_sha256, fence_generation,
         reservation_key, atomic_admission_sha256,
         operation_admission_sha256, billing_snapshot_sha256,
         client_request_sha256, owner_generation, ring_generation,
         source_shard_count, shard_index, admission_commit_sha256,
         committed_at, page_ordinal, member_ordinal, member_digest_sha256
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
         ?14, ?15, ?16, ?17, ?18, ?19, ?16
       )`,
    )
      .bind(
        source.sourceScanIdSha256,
        commit.accepted_sequence,
        commit.operation_id,
        commit.source_contract,
        commit.admission_fence_id_sha256,
        commit.fence_generation,
        commit.reservation_key,
        commit.atomic_admission_sha256,
        commit.operation_admission_sha256,
        commit.billing_snapshot_sha256,
        commit.client_request_sha256,
        commit.owner_generation,
        commit.ring_generation,
        commit.source_shard_count,
        commit.shard_index,
        commit.admission_commit_sha256,
        commit.committed_at,
        pageOrdinal,
        memberOrdinal,
      )
      .run();
  }

  const pageCount = Math.ceil(commits.length / pageSize);
  const pageDigests = [];
  for (let pageOrdinal = 1; pageOrdinal <= pageCount; pageOrdinal += 1) {
    pageDigests.push(await digest(`page-${pageOrdinal}`));
  }
  for (let pageOrdinal = 1; pageOrdinal <= pageCount; pageOrdinal += 1) {
    if (omittedPageOrdinals.includes(pageOrdinal)) {
      continue;
    }
    const pageMembers = commits.filter(
      (commit) =>
        Math.floor((commit.accepted_sequence - 1) / pageSize) + 1 ===
        pageOrdinal,
    );
    await env.DB.prepare(
      `INSERT INTO relay_container_drain_source_pages (
         source_scan_id_sha256, page_ordinal, page_member_count,
         page_first_sequence, page_first_operation_id, page_last_sequence,
         page_last_operation_id, previous_page_digest_sha256,
         page_digest_sha256
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        source.sourceScanIdSha256,
        pageOrdinal,
        pageMembers.length,
        pageMembers[0].accepted_sequence,
        pageMembers[0].operation_id,
        pageMembers.at(-1).accepted_sequence,
        pageMembers.at(-1).operation_id,
        pageOrdinal === 1 ? null : pageDigests[pageOrdinal - 2],
        pageDigests[pageOrdinal - 1],
      )
      .run();
  }

  for (let shardIndex = 0; shardIndex < source.shardCount; shardIndex += 1) {
    if (omittedShardIndexes.includes(shardIndex)) {
      continue;
    }
    const shardMembers = commits.filter(
      (commit) => commit.shard_index === shardIndex,
    );
    const first = shardMembers[0] ?? null;
    const last = shardMembers.at(-1) ?? null;
    await env.DB.prepare(
      `INSERT INTO relay_container_drain_source_shards (
         source_scan_id_sha256, shard_index, shard_member_count,
         shard_high_watermark, shard_first_sequence,
         shard_first_operation_id, shard_last_sequence,
         shard_last_operation_id, shard_manifest_sha256
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        source.sourceScanIdSha256,
        shardIndex,
        shardMembers.length,
        last?.accepted_sequence ?? 0,
        first?.accepted_sequence ?? 0,
        first?.operation_id ?? null,
        last?.accepted_sequence ?? 0,
        last?.operation_id ?? null,
        await digest(`shard-${shardIndex}`),
      )
      .run();
  }

  return {
    ...source,
    scanStartedAt: scanClock.started_at,
    pageCount,
    firstPageDigestSha256: pageDigests[0],
    lastPageDigestSha256: pageDigests.at(-1),
  };
}

function sourceAttestationStatement(source, role, overrides = {}) {
  const roleValues =
    role === "assembler"
      ? {
          issuer: "cinatoken-drain-source-assembler",
          keyId: "drain-source-assembler-v1",
          identitySha256: source.assemblerIdentitySha256,
          signerSpkiSha256: source.assemblerSpkiSha256,
          attestationSubjectSha256:
            source.assemblerAttestationSubjectSha256,
          signatureEnvelopeSha256:
            source.assemblerSignatureEnvelopeSha256,
        }
      : {
          issuer: "cinatoken-drain-source-verifier",
          keyId: "drain-source-verifier-v1",
          identitySha256: source.verifierIdentitySha256,
          signerSpkiSha256: source.verifierSpkiSha256,
          attestationSubjectSha256:
            source.verifierAttestationSubjectSha256,
          signatureEnvelopeSha256:
            source.verifierSignatureEnvelopeSha256,
        };
  const values = {
    ...roleValues,
    acceptedBookmarkSha256: source.acceptedBookmarkSha256,
    acceptedSetManifestSha256: source.acceptedSetManifestSha256,
    acceptedSourceReadbackSha256: source.acceptedSourceReadbackSha256,
    attestedAt: source.scanStartedAt,
    validUntil: source.permitExpiresAt,
    ...overrides,
  };
  return env.DB.prepare(
    `INSERT INTO relay_container_drain_source_attestations (
       authorization_id_sha256, attestation_role, contract_version,
       attestation_contract, attestation_migration,
       source_scan_id_sha256, source_seal_id_sha256, issuer, key_id,
       identity_sha256, signer_spki_sha256,
       attestation_subject_sha256, signature_envelope_sha256,
       accepted_bookmark_sha256, accepted_set_manifest_sha256,
       accepted_source_schema_sha256,
       accepted_source_readback_sha256, page_count,
       first_page_digest_sha256, last_page_digest_sha256,
       shard_set_manifest_sha256, captured_high_watermark,
       captured_member_count, captured_first_sequence,
       captured_first_operation_id, captured_last_sequence,
       captured_last_operation_id, attested_at, valid_until
     ) VALUES (
       ?1, ?2, 1, 'relay-container-drain-source-attestation-v1',
       '0072_relay_container_drain_source_authorization.sql',
       ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
       ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26
     )`,
  ).bind(
    source.authorizationIdSha256,
    role,
    source.sourceScanIdSha256,
    source.sourceSealIdSha256,
    values.issuer,
    values.keyId,
    values.identitySha256,
    values.signerSpkiSha256,
    values.attestationSubjectSha256,
    values.signatureEnvelopeSha256,
    values.acceptedBookmarkSha256,
    values.acceptedSetManifestSha256,
    source.acceptedSourceSchemaSha256,
    values.acceptedSourceReadbackSha256,
    source.pageCount,
    source.firstPageDigestSha256,
    source.lastPageDigestSha256,
    source.shardSetManifestSha256,
    source.capturedHighWatermark,
    source.capturedMemberCount,
    source.capturedFirstSequence,
    source.capturedFirstOperationId,
    source.capturedLastSequence,
    source.capturedLastOperationId,
    values.attestedAt,
    values.validUntil,
  );
}

async function attestAcceptedSource(source) {
  await sourceAttestationStatement(source, "assembler").run();
  await sourceAttestationStatement(source, "verifier").run();
}

function sourceSealStatement(source) {
  return env.DB.prepare(
    `INSERT INTO relay_container_drain_source_seals (
       source_seal_id_sha256, source_scan_id_sha256, contract_version,
       seal_contract, seal_migration, bookmark_contract,
       pagination_contract, accepted_bookmark_sha256,
       accepted_set_manifest_sha256, accepted_source_schema_sha256,
       accepted_source_readback_sha256, page_count,
       first_page_digest_sha256, last_page_digest_sha256,
       shard_set_manifest_sha256, assembler_identity_sha256,
       assembler_signature_envelope_sha256, verifier_identity_sha256,
       verifier_signature_envelope_sha256, seal_digest_sha256
     ) VALUES (
       ?1, ?2, 1, 'relay-container-drain-source-seal-v1',
       '0071_relay_container_drain_accepted_set_source_seal.sql',
       'd1-session-first-primary-bookmark-v1',
       'accepted-sequence-keyset-v1', ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       ?10, ?11, ?12, ?13, ?14, ?15
     )`,
  ).bind(
    source.sourceSealIdSha256,
    source.sourceScanIdSha256,
    source.acceptedBookmarkSha256,
    source.acceptedSetManifestSha256,
    source.acceptedSourceSchemaSha256,
    source.acceptedSourceReadbackSha256,
    source.pageCount,
    source.firstPageDigestSha256,
    source.lastPageDigestSha256,
    source.shardSetManifestSha256,
    source.assemblerIdentitySha256,
    source.assemblerSignatureEnvelopeSha256,
    source.verifierIdentitySha256,
    source.verifierSignatureEnvelopeSha256,
    source.sealDigestSha256,
  );
}

function sourceTerminalStatement(source, overrides = {}) {
  const values = {
    terminalOutcome: "succeeded",
    terminalPhase: "evidence",
    sourceSealIdSha256: source.sourceSealIdSha256,
    sourceSealDigestSha256: source.sealDigestSha256,
    failureClass: null,
    ambiguityClass: null,
    evidenceManifestSha256: source.evidenceManifestSha256,
    evidenceObjectKey: `relay-container/p5/0073/${source.authorizationIdSha256}.json`,
    evidenceObjectVersionSha256: source.evidenceObjectVersionSha256,
    evidenceObjectEtagSha256: source.evidenceObjectEtagSha256,
    evidenceContentSha256: source.evidenceContentSha256,
    evidenceBytes: 4096,
    retentionPolicySha256: source.retentionPolicySha256,
    reasonCode: "retained-source-evidence",
    ...overrides,
  };
  return env.DB.prepare(
    `INSERT INTO relay_container_drain_source_terminal_receipts (
       authorization_id_sha256, contract_version, terminal_contract,
       terminal_migration, authority_ledger_identity_sha256,
       registration_receipt_sha256, claim_id_sha256,
       claim_digest_sha256, receipt_sequence,
       predecessor_receipt_sha256, terminal_outcome, terminal_phase,
       source_scan_id_sha256, source_seal_id_sha256,
       source_seal_digest_sha256, failure_class, ambiguity_class,
       evidence_manifest_sha256, evidence_object_key,
       evidence_object_version_sha256, evidence_object_etag_sha256,
       evidence_content_sha256, evidence_bytes,
       retention_policy_sha256, terminal_actor_service_name,
       terminal_actor_version_id, terminal_actor_execution_id_sha256,
       terminal_credential_id_sha256, reason_code,
       observation_sha256, terminal_receipt_sha256
     ) VALUES (
       ?1, 1, 'relay-container-drain-source-authorization-terminal-v1',
       '0073_relay_container_drain_source_authorization_consumption.sql',
       ?2, ?3, ?4, ?5, 3, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
       ?13, ?14, ?15, ?16, ?17, ?18, ?19,
       'cinatoken-drain-evidence-writer', 'runtime-test-v1',
       ?20, ?21, ?22, ?23, ?24
     )`,
  ).bind(
    source.authorizationIdSha256,
    admissionScopeId,
    source.registrationReceiptSha256,
    source.claimIdSha256,
    source.claimDigestSha256,
    values.terminalOutcome,
    values.terminalPhase,
    source.sourceScanIdSha256,
    values.sourceSealIdSha256,
    values.sourceSealDigestSha256,
    values.failureClass,
    values.ambiguityClass,
    values.evidenceManifestSha256,
    values.evidenceObjectKey,
    values.evidenceObjectVersionSha256,
    values.evidenceObjectEtagSha256,
    values.evidenceContentSha256,
    values.evidenceBytes,
    values.retentionPolicySha256,
    source.terminalActorExecutionIdSha256,
    source.terminalCredentialIdSha256,
    values.reasonCode,
    source.terminalObservationSha256,
    source.terminalReceiptSha256,
  );
}

function sourceClaimRepositoryStatement(session, source, leaseSeconds = 240) {
  return session
    .prepare(
      `INSERT INTO relay_container_drain_source_authorization_claims (
         authorization_id_sha256, contract_version, claim_contract,
         claim_migration, authority_ledger_identity_sha256,
         registration_receipt_sha256, execution_nonce_sha256,
         claim_id_sha256, claim_request_sha256,
         predecessor_receipt_sha256, receipt_sequence,
         claim_digest_sha256, claim_owner_service_name,
         claim_owner_version_id, claim_owner_execution_id_sha256,
         claim_credential_id_sha256, lease_expires_at, claimed_at
       )
       SELECT authorization.authorization_id_sha256, 1,
              'relay-container-drain-source-authorization-claim-v1',
              '0073_relay_container_drain_source_authorization_consumption.sql',
              registration.authority_ledger_identity_sha256,
              registration.registration_receipt_sha256,
              authorization.execution_nonce_sha256,
              ?2, ?3, registration.registration_receipt_sha256,
              registration.receipt_sequence + 1, ?4,
              authorization.collector_service_name,
              authorization.collector_version_id,
              authorization.collector_run_id_sha256,
              authorization.started_by_credential_id_sha256,
              unixepoch() + ?5, unixepoch()
       FROM relay_container_drain_source_authorizations AS authorization
       JOIN relay_container_drain_source_authorization_registrations
            AS registration
         ON registration.authorization_id_sha256 =
              authorization.authorization_id_sha256
       WHERE authorization.authorization_id_sha256 = ?1
         AND NOT EXISTS (
           SELECT 1
           FROM relay_container_drain_source_authorization_claims AS existing
           WHERE existing.authorization_id_sha256 =
                 authorization.authorization_id_sha256
         )`,
    )
    .bind(
      source.authorizationIdSha256,
      source.claimIdSha256,
      source.claimRequestSha256,
      source.claimDigestSha256,
      leaseSeconds,
    );
}

function sourceTerminalRepositoryStatement(session, source, overrides = {}) {
  const values = {
    terminalOutcome: "succeeded",
    terminalPhase: "evidence",
    sourceSealIdSha256: source.sourceSealIdSha256,
    sourceSealDigestSha256: source.sealDigestSha256,
    failureClass: null,
    ambiguityClass: null,
    evidenceManifestSha256: source.evidenceManifestSha256,
    evidenceObjectKey: `relay-container/p5/0073/${source.authorizationIdSha256}.json`,
    evidenceObjectVersionSha256: source.evidenceObjectVersionSha256,
    evidenceObjectEtagSha256: source.evidenceObjectEtagSha256,
    evidenceContentSha256: source.evidenceContentSha256,
    evidenceBytes: 4096,
    retentionPolicySha256: source.retentionPolicySha256,
    reasonCode: "retained-source-evidence",
    ...overrides,
  };
  return session
    .prepare(
      `INSERT INTO relay_container_drain_source_terminal_receipts (
         authorization_id_sha256, contract_version, terminal_contract,
         terminal_migration, authority_ledger_identity_sha256,
         registration_receipt_sha256, claim_id_sha256,
         claim_digest_sha256, receipt_sequence,
         predecessor_receipt_sha256, terminal_outcome,
         terminal_phase, source_scan_id_sha256,
         source_seal_id_sha256, source_seal_digest_sha256,
         failure_class, ambiguity_class, evidence_manifest_sha256,
         evidence_object_key, evidence_object_version_sha256,
         evidence_object_etag_sha256, evidence_content_sha256,
         evidence_bytes, retention_policy_sha256,
         terminal_actor_service_name, terminal_actor_version_id,
         terminal_actor_execution_id_sha256,
         terminal_credential_id_sha256, reason_code,
         observation_sha256, terminal_receipt_sha256, terminal_at
       )
       SELECT authorization.authorization_id_sha256, 1,
              'relay-container-drain-source-authorization-terminal-v1',
              '0073_relay_container_drain_source_authorization_consumption.sql',
              claim.authority_ledger_identity_sha256,
              registration.registration_receipt_sha256,
              claim.claim_id_sha256, claim.claim_digest_sha256,
              claim.receipt_sequence + 1, claim.claim_digest_sha256,
              ?2, ?3, authorization.source_scan_id_sha256,
              ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
              ?15, ?16, ?17, ?18, ?19, ?20, ?21, unixepoch()
       FROM relay_container_drain_source_authorizations AS authorization
       JOIN relay_container_drain_source_authorization_registrations
            AS registration
         ON registration.authorization_id_sha256 =
              authorization.authorization_id_sha256
       JOIN relay_container_drain_source_authorization_claims AS claim
         ON claim.authorization_id_sha256 =
              authorization.authorization_id_sha256
       WHERE authorization.authorization_id_sha256 = ?1
         AND NOT EXISTS (
           SELECT 1
           FROM relay_container_drain_source_terminal_receipts AS existing
           WHERE existing.authorization_id_sha256 =
                 authorization.authorization_id_sha256
         )`,
    )
    .bind(
      source.authorizationIdSha256,
      values.terminalOutcome,
      values.terminalPhase,
      values.sourceSealIdSha256,
      values.sourceSealDigestSha256,
      values.failureClass,
      values.ambiguityClass,
      values.evidenceManifestSha256,
      values.evidenceObjectKey,
      values.evidenceObjectVersionSha256,
      values.evidenceObjectEtagSha256,
      values.evidenceContentSha256,
      values.evidenceBytes,
      values.retentionPolicySha256,
      "cinatoken-drain-evidence-writer",
      "runtime-test-v1",
      source.terminalActorExecutionIdSha256,
      source.terminalCredentialIdSha256,
      values.reasonCode,
      source.terminalObservationSha256,
      source.terminalReceiptSha256,
    );
}

async function sealAcceptedSource(intents, options) {
  const source = await prepareAcceptedSource(intents, options);
  await attestAcceptedSource(source);
  await sourceTerminalStatement(source).run();
  return source;
}

async function drainCloseCommand(intent, source) {
  const digest = (field) =>
    sha256Text(`relay-container-drain-close:${intent.operationId}:${field}`);
  return {
    closeCommandIdSha256: await digest("command-id"),
    campaignId: await digest("campaign-id"),
    acceptedHighWatermark: source.capturedHighWatermark,
    acceptedBookmarkSha256: source.acceptedBookmarkSha256,
    acceptedMemberCount: source.capturedMemberCount,
    acceptedSetManifestSha256: source.acceptedSetManifestSha256,
    acceptedFirstSequence: source.capturedFirstSequence,
    acceptedFirstOperationId: source.capturedFirstOperationId,
    acceptedLastSequence: source.capturedLastSequence,
    acceptedLastOperationId: source.capturedLastOperationId,
    acceptedSourceSchemaSha256: source.acceptedSourceSchemaSha256,
    acceptedSourceReadbackSha256: source.acceptedSourceReadbackSha256,
    closedFenceStateDigestSha256: await digest("closed-fence-state"),
    shardInventorySha256: await digest("shard-inventory"),
    edgeVersionSetSha256: await digest("edge-version-set"),
    configurationSha256: await digest("configuration"),
    reverseSyncSnapshotIdSha256: await digest("reverse-sync-snapshot"),
    reverseSyncSourceSchemaSha256: await digest("reverse-source-schema"),
    reverseSyncTargetSchemaSha256: await digest("reverse-target-schema"),
    campaignDigestSha256: await digest("campaign-digest"),
    commandDigestSha256: await digest("command-digest"),
  };
}

function drainCloseCommandStatement(command) {
  return env.DB.prepare(
    `INSERT INTO relay_container_drain_close_commands (
       close_command_id_sha256, contract_version, command_contract,
       command_migration, environment, scope_kind, scope_id_sha256,
       admission_fence_id_sha256, fence_generation,
       expected_fence_state_digest_sha256, expected_head_version,
       expected_head_digest_sha256, campaign_id,
       accepted_high_watermark, accepted_bookmark_sha256,
       accepted_member_count, accepted_set_manifest_sha256,
       accepted_first_sequence, accepted_first_operation_id,
       accepted_last_sequence, accepted_last_operation_id,
       accepted_source_schema_sha256, accepted_source_readback_sha256,
       closed_fence_state_digest_sha256, ring_generation,
       controller_service_name, controller_version_id, shard_count,
       shard_inventory_sha256, edge_version_set_sha256,
       configuration_sha256, reverse_sync_snapshot_id_sha256,
       reverse_sync_source_schema_sha256,
       reverse_sync_target_schema_sha256, stability_window_seconds,
       campaign_digest_sha256, requested_by_admin_id,
       command_digest_sha256, created_at
     ) VALUES (
       ?1, 1, 'relay-container-drain-close-command-v1',
       '0070_relay_container_drain_close_command.sql',
       'staging', 'global', ?2, ?3, 1, ?4, 1, ?5, ?6,
       ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
       1, 'relay-controller', 'controller-v1', 8, ?18, ?19, ?20,
       ?21, ?22, ?23, 60, ?24, 42, ?25, unixepoch()
     )`,
  ).bind(
    command.closeCommandIdSha256,
    admissionScopeId,
    admissionFenceId,
    hex("7"),
    hex("8"),
    command.campaignId,
    command.acceptedHighWatermark,
    command.acceptedBookmarkSha256,
    command.acceptedMemberCount,
    command.acceptedSetManifestSha256,
    command.acceptedFirstSequence,
    command.acceptedFirstOperationId,
    command.acceptedLastSequence,
    command.acceptedLastOperationId,
    command.acceptedSourceSchemaSha256,
    command.acceptedSourceReadbackSha256,
    command.closedFenceStateDigestSha256,
    command.shardInventorySha256,
    command.edgeVersionSetSha256,
    command.configurationSha256,
    command.reverseSyncSnapshotIdSha256,
    command.reverseSyncSourceSchemaSha256,
    command.reverseSyncTargetSchemaSha256,
    command.campaignDigestSha256,
    command.commandDigestSha256,
  );
}

function admissionCommitStatement(intent) {
  return env.DB.prepare(
    `INSERT INTO relay_container_admission_commits (
       source_contract, scope_kind, scope_id_sha256,
       admission_fence_id_sha256, fence_generation,
       reservation_key, operation_id, atomic_admission_sha256,
       operation_admission_sha256, billing_snapshot_sha256,
       client_request_sha256, owner_generation, ring_generation,
       shard_count, shard_index, admission_commit_sha256
     ) VALUES (
       'fenced-atomic-admission-v1', ?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7,
       ?8, ?9, ?10, ?11, ?12, ?13, ?14
     )`,
  ).bind(
    intent.scopeKind,
    intent.scopeIdSha256,
    intent.admissionFenceIdSha256,
    intent.fenceGeneration,
    intent.reservationKey,
    intent.atomicAdmissionSha256,
    intent.operationAdmissionSha256,
    intent.billingSnapshotSha256,
    intent.clientRequestSha256,
    intent.ownerGeneration,
    intent.ringGeneration,
    intent.shardCount,
    intent.shardIndex,
    intent.admissionCommitSha256,
  );
}

function idempotencyAliasStatement(intent, alias) {
  return env.DB.prepare(
    `INSERT INTO relay_container_idempotency_aliases (
       client_idempotency_hmac_sha256, reservation_key, operation_id,
       canonical_client_idempotency_hmac_sha256, client_request_sha256,
       created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT DO NOTHING`,
  ).bind(
    alias,
    intent.reservationKey,
    intent.operationId,
    intent.clientIdempotencyHmacSha256,
    intent.clientRequestSha256,
    intent.createdAt,
  );
}

function selectedReservationStatement(intent) {
  return env.DB.prepare(
    `INSERT INTO relay_billing_reservations (
       reservation_key, user_id, token_id, model_name, endpoint_path,
       request_id_hash, expr_hash, billing_kind, billing_snapshot_json,
       candidate_group_count, reservation_strategy, pre_consumed_quota,
       status, channel_id, selected_group, selected_at, owner_generation,
       owner_deadline_at, created_at, updated_at, lease_expires_at
     ) VALUES (
       ?1, ?2, ?3, ?4, 'chat/completions', ?5, ?6, 'flat', ?7,
       1, 'selected_group', ?8, 'reserved', ?9, ?10, ?11, ?12,
       ?13, ?11, ?11, ?13
     )`,
  ).bind(
    intent.reservationKey,
    userId,
    tokenId,
    intent.modelName,
    intent.clientRequestSha256,
    `sha256:${intent.operationAdmissionSha256}`,
    intent.billingSnapshotJson,
    intent.preConsumedQuota,
    intent.channelId,
    intent.selectedGroup,
    intent.selectedAt,
    intent.ownerGeneration,
    intent.ownerLeaseExpiresAt,
  );
}

function userDebitStatement(intent) {
  return env.DB.prepare(
    `UPDATE users
     SET quota = quota - ?1
     WHERE id = ?2
       AND status = 1
       AND deleted_at IS NULL
       AND quota >= ?1`,
  ).bind(intent.preConsumedQuota, userId);
}

function tokenDebitStatement(intent) {
  return env.DB.prepare(
    `UPDATE tokens
     SET remain_quota = remain_quota - ?1,
         used_quota = used_quota + ?1,
         accessed_time = ?2
     WHERE id = ?3
       AND user_id = ?4
       AND status = 1
       AND deleted_at IS NULL
       AND (expired_time = -1 OR expired_time >= ?2)
       AND (unlimited_quota != 0 OR remain_quota >= ?1)`,
  ).bind(intent.preConsumedQuota, intent.createdAt, tokenId, userId);
}

function channelAuthorityStatement(intent) {
  return env.DB.prepare(
    `UPDATE channels AS channel
     SET status = status
     WHERE id = ?1
       AND status = 1
       AND type = ?2
       AND instr(',' || replace(channel."group", ' ', '') || ',',
                 ',' || replace(?3, ' ', '') || ',') > 0
       AND EXISTS (
         SELECT 1 FROM abilities AS ability
         WHERE ability.channel_id = channel.id
           AND ability.group_name = ?3
           AND ability.model = ?4
           AND ability.enabled = 1
       )`,
  ).bind(
    intent.channelId,
    intent.selectedChannelType,
    intent.selectedGroup,
    intent.modelName,
  );
}

function previousChangeAssertion(intent) {
  return env.DB.prepare(
    `INSERT INTO relay_billing_reservations (
       reservation_key, user_id, model_name, pre_consumed_quota,
       lease_expires_at, created_at, updated_at
     )
     SELECT ?1, 0, '', 0, 0, 0, 0
     WHERE changes() != 1`,
  ).bind(intent.reservationKey);
}

function preparedOperationStatement(
  intent,
  {
    includeResponseArtifactContract = true,
    operationKind = "chat_completions_canary",
    protocolVersion = 1,
  } = {},
) {
  const responseArtifactContractColumn = includeResponseArtifactContract
    ? ", response_artifact_contract"
    : "";
  const responseArtifactContractValue = includeResponseArtifactContract
    ? ", 'container-response-artifacts-v1'"
    : "";
  return env.DB.prepare(
    `INSERT INTO relay_container_operations (
       reservation_key, operation_id, owner_generation,
       owner_lease_expires_at, channel_id, selected_group, operation_kind,
       provider_operation_id, admission_sha256, protocol_version,
       shard_contract_version, ring_generation, shard_count, shard_index,
       instance_name, execution_deadline_at, input_mode, input_object_key,
       input_object_version, input_sha256, input_size, input_content_type,
       trace_id, client_idempotency_hmac_sha256, client_request_sha256,
       reconciliation_id${responseArtifactContractColumn},
       status, created_at, updated_at
     ) VALUES (
       ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       1, ?10, ?11, ?12, ?13, ?14, 'r2', ?15,
       ?16, ?17, 0, 'application/json', ?18, ?19, ?20, ?21${responseArtifactContractValue},
       'prepared', ?22, ?22
     )`,
  ).bind(
    intent.operationId,
    intent.ownerGeneration,
    intent.ownerLeaseExpiresAt,
    intent.channelId,
    intent.selectedGroup,
    operationKind,
    intent.providerOperationId,
    intent.operationAdmissionSha256,
    protocolVersion,
    intent.ringGeneration,
    intent.shardCount,
    intent.shardIndex,
    `cinatoken-relay-shard-v1-${String(intent.shardIndex).padStart(4, "0")}`,
    intent.executionDeadlineAt,
    intent.inputObjectKey,
    intent.inputObjectVersion,
    intent.inputSha256,
    intent.traceId,
    intent.clientIdempotencyHmacSha256,
    intent.clientRequestSha256,
    intent.reconciliationId,
    intent.createdAt,
  );
}

function atomicAdmissionStatement(intent, markerOperationAdmissionSha256) {
  return env.DB.prepare(
    `INSERT INTO relay_container_atomic_admissions (
       reservation_key, operation_id, contract_version,
       atomic_admission_sha256, operation_admission_sha256,
       client_idempotency_hmac_sha256, client_request_sha256,
       idempotency_alias_count, idempotency_aliases_sha256,
       billing_snapshot_sha256, user_id, token_id, pre_consumed_quota,
       owner_generation, owner_lease_expires_at, channel_id,
       selected_channel_type, selected_group, selected_snapshot_key,
       owner_deadline_at, selected_at, created_at,
       attempt_count, provider_attempt_generation
     ) VALUES (
       ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
       ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, 1, 1
     )`,
  ).bind(
    intent.reservationKey,
    intent.contractVersion,
    intent.atomicAdmissionSha256,
    markerOperationAdmissionSha256,
    intent.clientIdempotencyHmacSha256,
    intent.clientRequestSha256,
    intent.idempotencyAliasCount,
    intent.idempotencyAliasesSha256,
    intent.billingSnapshotSha256,
    userId,
    tokenId,
    intent.preConsumedQuota,
    intent.ownerGeneration,
    intent.ownerLeaseExpiresAt,
    intent.channelId,
    intent.selectedChannelType,
    intent.selectedGroup,
    intent.selectedSnapshotKey,
    intent.ownerLeaseExpiresAt,
    intent.selectedAt,
  );
}

async function admitOrClassifyExactReplay(intent) {
  const existing = await classifyAtomicAdmissionReadback(intent);
  if (existing.classification !== "no_state") {
    return existing;
  }

  try {
    const results = await runAtomicAdmissionBatch(intent);
    const persisted = await classifyAtomicAdmissionReadback(intent);
    if (persisted.classification !== "matching_resumable") {
      throw new Error(
        `atomic admission readback after commit was ${persisted.classification}`,
      );
    }
    return { ...persisted, classification: "newly_applied", results };
  } catch (error) {
    const persisted = await classifyAtomicAdmissionReadback(intent);
    if (persisted.classification === "no_state") {
      throw error;
    }
    return { ...persisted, error };
  }
}

async function classifyAtomicAdmission(intent) {
  return (await classifyAtomicAdmissionReadback(intent)).classification;
}

async function classifyAtomicAdmissionReadback(intent) {
  let winner = null;
  for (const alias of intent.clientIdempotencyHmacAliases) {
    const row = await persistedAtomicAdmissionByAlias(alias);
    if (row === null) {
      continue;
    }
    if (
      row.admission_reservation_key !== null &&
      row.operation_reservation_key !== null &&
      (row.alias_client_request_sha256 !== intent.clientRequestSha256 ||
        row.admission_client_request_sha256 !== intent.clientRequestSha256 ||
        row.operation_client_request_sha256 !== intent.clientRequestSha256)
    ) {
      return { classification: "request_conflict" };
    }
    if (!(await persistedAtomicAdmissionIsValid(row))) {
      return { classification: "immutable_conflict" };
    }
    if (winner !== null && winner.operation_id !== row.operation_id) {
      return { classification: "immutable_conflict" };
    }
    winner = row;
  }

  if (winner === null) {
    const residue = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM relay_billing_reservations
          WHERE reservation_key = ?1) AS reservations,
         (SELECT COUNT(*) FROM relay_container_operations
          WHERE reservation_key = ?1) AS operations,
         (SELECT COUNT(*) FROM relay_container_atomic_admissions
          WHERE reservation_key = ?1) AS admissions,
         (SELECT COUNT(*) FROM relay_container_idempotency_aliases
          WHERE reservation_key = ?1) AS aliases`,
    )
      .bind(intent.reservationKey)
      .first();
    return {
      classification: Object.values(residue).every((count) => count === 0)
        ? "no_state"
        : "immutable_conflict",
    };
  }

  const persistedWinner = {
    reservationKey: winner.reservation_key,
    operationId: winner.operation_id,
    canonicalClientIdempotencyHmacSha256:
      winner.admission_client_idempotency_hmac_sha256,
    clientRequestSha256: winner.admission_client_request_sha256,
  };
  if (
    winner.operation_status === "prepared" ||
    winner.operation_status === "dispatched"
  ) {
    return {
      classification:
        winner.reservation_status === "reserved" &&
        winner.reservation_owner_generation === winner.owner_generation &&
        winner.reservation_owner_deadline_at ===
          winner.owner_lease_expires_at
          ? "matching_resumable"
          : "immutable_conflict",
      winner: persistedWinner,
    };
  }
  if (
    winner.operation_status === "completed" ||
    winner.operation_status === "failed"
  ) {
    return { classification: "terminal_replay", winner: persistedWinner };
  }
  if (winner.operation_status === "recovery_required") {
    return { classification: "matching_resumable", winner: persistedWinner };
  }
  return { classification: "immutable_conflict", winner: persistedWinner };
}

async function persistedAtomicAdmissionByAlias(alias) {
  return env.DB.prepare(
    `SELECT
       alias.client_idempotency_hmac_sha256 AS alias_sha256,
       alias.reservation_key AS alias_reservation_key,
       alias.operation_id AS alias_operation_id,
       alias.canonical_client_idempotency_hmac_sha256 AS alias_canonical_sha256,
       alias.client_request_sha256 AS alias_client_request_sha256,
       alias.created_at AS alias_created_at,
       admission.reservation_key AS admission_reservation_key,
       admission.operation_id AS operation_id,
       admission.contract_version,
       admission.operation_admission_sha256,
       admission.client_idempotency_hmac_sha256 AS admission_client_idempotency_hmac_sha256,
       admission.client_request_sha256 AS admission_client_request_sha256,
       admission.idempotency_alias_count,
       admission.idempotency_aliases_sha256,
       admission.billing_snapshot_sha256,
       admission.user_id,
       admission.token_id,
       admission.pre_consumed_quota AS admission_pre_consumed_quota,
       admission.owner_generation,
       admission.owner_lease_expires_at,
       admission.channel_id,
       admission.selected_channel_type,
       admission.selected_group,
       admission.selected_snapshot_key,
       admission.owner_deadline_at,
       admission.selected_at,
       admission.created_at,
       admission.attempt_count,
       admission.provider_attempt_generation,
       reservation.reservation_key,
       reservation.billing_snapshot_json,
       reservation.user_id AS reservation_user_id,
       reservation.token_id AS reservation_token_id,
       reservation.pre_consumed_quota,
       reservation.owner_generation AS reservation_owner_generation,
       reservation.lease_expires_at AS reservation_owner_lease_expires_at,
       reservation.owner_deadline_at AS reservation_owner_deadline_at,
       reservation.channel_id AS reservation_channel_id,
       reservation.selected_group AS reservation_selected_group,
       reservation.selected_at AS reservation_selected_at,
       reservation.created_at AS reservation_created_at,
       reservation.status AS reservation_status,
       operation.reservation_key AS operation_reservation_key,
       operation.status AS operation_status,
       operation.operation_kind,
       operation.protocol_version,
       operation.admission_sha256 AS stored_operation_admission_sha256,
       operation.client_idempotency_hmac_sha256 AS operation_client_idempotency_hmac_sha256,
       operation.client_request_sha256 AS operation_client_request_sha256,
       operation.owner_generation AS operation_owner_generation,
       operation.owner_lease_expires_at AS operation_owner_lease_expires_at,
       operation.channel_id AS operation_channel_id,
       operation.selected_group AS operation_selected_group,
       operation.created_at AS operation_created_at
     FROM relay_container_idempotency_aliases AS alias
     LEFT JOIN relay_container_atomic_admissions AS admission
       ON admission.reservation_key = alias.reservation_key
     LEFT JOIN relay_billing_reservations AS reservation
       ON reservation.reservation_key = alias.reservation_key
     LEFT JOIN relay_container_operations AS operation
       ON operation.operation_id = alias.operation_id
      AND operation.reservation_key = alias.reservation_key
     WHERE alias.client_idempotency_hmac_sha256 = ?1
     LIMIT 1`,
  )
    .bind(alias)
    .first();
}

async function persistedAtomicAdmissionIsValid(row) {
  const aliases = await env.DB.prepare(
    `SELECT client_idempotency_hmac_sha256,
            reservation_key, operation_id,
            canonical_client_idempotency_hmac_sha256,
            client_request_sha256, created_at
     FROM relay_container_idempotency_aliases
     WHERE reservation_key = ?1
     ORDER BY client_idempotency_hmac_sha256
     LIMIT 3`,
  )
    .bind(row.admission_reservation_key)
    .all();
  const aliasRows = aliases.results;
  const aliasValues = aliasRows.map(
    ({ client_idempotency_hmac_sha256 }) =>
      client_idempotency_hmac_sha256,
  );
  return (
    row.alias_reservation_key === row.admission_reservation_key &&
    row.alias_operation_id === row.operation_id &&
    row.alias_canonical_sha256 ===
      row.admission_client_idempotency_hmac_sha256 &&
    row.alias_client_request_sha256 ===
      row.admission_client_request_sha256 &&
    row.alias_created_at === row.created_at &&
    row.admission_reservation_key === row.reservation_key &&
    row.admission_reservation_key === row.operation_reservation_key &&
    row.operation_id === row.operation_reservation_key &&
    row.contract_version === 1 &&
    row.operation_admission_sha256 === row.stored_operation_admission_sha256 &&
    row.admission_client_idempotency_hmac_sha256 ===
      row.operation_client_idempotency_hmac_sha256 &&
    row.admission_client_request_sha256 ===
      row.operation_client_request_sha256 &&
    aliasRows.length === row.idempotency_alias_count &&
    aliasRows.length >= 1 &&
    aliasRows.length <= 2 &&
    aliasValues.includes(row.admission_client_idempotency_hmac_sha256) &&
    row.idempotency_aliases_sha256 ===
      (await idempotencyAliasesSha256(aliasValues)) &&
    aliasRows.every(
      (aliasRow) =>
        aliasRow.reservation_key === row.admission_reservation_key &&
        aliasRow.operation_id === row.operation_id &&
        aliasRow.canonical_client_idempotency_hmac_sha256 ===
          row.admission_client_idempotency_hmac_sha256 &&
        aliasRow.client_request_sha256 ===
          row.admission_client_request_sha256 &&
        aliasRow.created_at === row.created_at,
    ) &&
    row.billing_snapshot_sha256 ===
      (await sha256Text(row.billing_snapshot_json)) &&
    row.user_id === userId &&
    row.token_id === tokenId &&
    row.admission_pre_consumed_quota === row.pre_consumed_quota &&
    row.owner_generation === 2 &&
    row.owner_lease_expires_at === row.reservation_owner_lease_expires_at &&
    row.owner_deadline_at === row.reservation_owner_deadline_at &&
    row.channel_id === row.reservation_channel_id &&
    row.selected_group === row.reservation_selected_group &&
    row.selected_snapshot_key === String(row.selected_channel_type) &&
    row.selected_at === row.reservation_selected_at &&
    row.created_at === row.reservation_created_at &&
    row.attempt_count === 1 &&
    row.provider_attempt_generation === 1 &&
    row.reservation_user_id === userId &&
    row.reservation_token_id === tokenId &&
    row.operation_owner_generation === row.owner_generation &&
    row.operation_owner_lease_expires_at === row.owner_lease_expires_at &&
    row.operation_channel_id === row.channel_id &&
    row.operation_selected_group === row.selected_group &&
    row.operation_created_at === row.created_at &&
    row.protocol_version === 1 &&
    row.operation_kind === "chat_completions_canary"
  );
}

async function atomicAdmissionState(intent) {
  const [user, token, channel, counts] = await Promise.all([
    env.DB.prepare(
      "SELECT quota, used_quota, request_count FROM users WHERE id = ?1",
    )
      .bind(userId)
      .first(),
    env.DB.prepare(
      `SELECT remain_quota, used_quota, accessed_time
       FROM tokens WHERE id = ?1`,
    )
      .bind(tokenId)
      .first(),
    env.DB.prepare("SELECT used_quota FROM channels WHERE id = ?1")
      .bind(channelId)
      .first(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM relay_billing_reservations) AS reservations,
         (SELECT COUNT(*) FROM relay_container_operations) AS operations,
         (SELECT COUNT(*) FROM relay_container_atomic_admissions) AS admissions,
         (SELECT COUNT(*) FROM relay_container_idempotency_aliases) AS aliases,
         (SELECT COUNT(*) FROM relay_container_admission_commits) AS commits`,
    )
      .first(),
  ]);
  return { user, token, channel, counts };
}

async function idempotencyAliasesSha256(aliases) {
  const encoder = new TextEncoder();
  const values = [
    "cinatoken:relay-container-idempotency-alias-set:v1",
    ...[...aliases].sort(),
  ].map((value) => encoder.encode(value));
  const encoded = new Uint8Array(
    values.reduce((length, value) => length + 8 + value.byteLength, 0),
  );
  const view = new DataView(encoded.buffer);
  let offset = 0;
  for (const value of values) {
    view.setBigUint64(offset, BigInt(value.byteLength), false);
    offset += 8;
    encoded.set(value, offset);
    offset += value.byteLength;
  }
  return sha256Bytes(encoded);
}

async function relayContainerAdmissionCommitSha256(intent) {
  const encoder = new TextEncoder();
  const integerField = (value) => {
    const encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigInt64(0, BigInt(value), false);
    return encoded;
  };
  const fields = [
    "cinatoken:relay-container-admission-commit:v1",
    "fenced-atomic-admission-v1",
    intent.environment,
    intent.scopeKind,
    intent.scopeIdSha256,
    intent.admissionFenceIdSha256,
    intent.reservationKey,
    intent.operationId,
    intent.atomicAdmissionSha256,
    intent.operationAdmissionSha256,
    intent.billingSnapshotSha256,
    intent.clientRequestSha256,
  ]
    .map((value) => encoder.encode(value))
    .concat(
      [
        intent.fenceGeneration,
        intent.ownerGeneration,
        intent.ringGeneration,
        intent.shardCount,
        intent.shardIndex,
      ].map(integerField),
    );
  const encoded = new Uint8Array(
    fields.reduce((length, value) => length + 8 + value.byteLength, 0),
  );
  const view = new DataView(encoded.buffer);
  let offset = 0;
  for (const value of fields) {
    view.setBigUint64(offset, BigInt(value.byteLength), false);
    offset += 8;
    encoded.set(value, offset);
    offset += value.byteLength;
  }
  return sha256Bytes(encoded);
}

async function sha256Text(value) {
  return sha256Bytes(new TextEncoder().encode(value));
}

async function sha256Bytes(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hex(character) {
  return character.repeat(64);
}
