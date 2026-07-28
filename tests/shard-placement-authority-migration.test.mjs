import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const migrationPath = join(
  import.meta.dir,
  "..",
  "services",
  "shard-placement-authority",
  "migrations",
  "0001_shard_placement_authorizations.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");
const executionMigrationSql = readFileSync(join(
  import.meta.dir,
  "..",
  "services",
  "shard-placement-authority",
  "migrations",
  "0002_shard_placement_execution_claims.sql",
), "utf8");

describe("shard placement Authority migration", () => {
  test("installs the exact isolated append-only catalog", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);

    expect(database.query(`
      SELECT type || ':' || name AS identity
      FROM sqlite_master
      WHERE tbl_name IN (
        'shard_placement_authority_issuances',
        'shard_placement_authority_revocations'
      )
        AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY identity
    `).all().map((row) => row.identity)).toEqual([
      "index:idx_shard_placement_authority_issuance_subject",
      "index:idx_shard_placement_authority_issuances_candidate",
      "index:idx_shard_placement_authority_revocations_recorded",
      "table:shard_placement_authority_issuances",
      "table:shard_placement_authority_revocations",
      "trigger:shard_placement_authority_issuance_delete_guard",
      "trigger:shard_placement_authority_issuance_insert_guard",
      "trigger:shard_placement_authority_issuance_update_guard",
      "trigger:shard_placement_authority_revocation_delete_guard",
      "trigger:shard_placement_authority_revocation_insert_guard",
      "trigger:shard_placement_authority_revocation_update_guard",
    ]);
    expect(database.query(
      "PRAGMA table_info('shard_placement_authority_issuances')",
    ).all()).toHaveLength(42);
    expect(database.query(
      "PRAGMA table_info('shard_placement_authority_revocations')",
    ).all()).toHaveLength(7);
  });

  test("fences replay and preserves issuance and revocation evidence", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);

    const row = validIssuance();
    insertIssuance(database, row);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM shard_placement_authority_issuances",
    ).get().count).toBe(1);

    expect(() => insertIssuance(database, {
      ...row,
      authorization_id_sha256: "a".repeat(64),
    })).toThrow();
    expect(() => database.query(`
      UPDATE shard_placement_authority_issuances
      SET controller_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `).run(row.authorization_id_sha256)).toThrow(
      "placement authority issuances are immutable",
    );
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_issuances
      WHERE authorization_id_sha256 = ?
    `).run(row.authorization_id_sha256)).toThrow(
      "placement authority issuances are append-preserved",
    );

    database.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      row.authorization_id_sha256,
      row.permit_subject_digest_sha256,
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
    );
    expect(() => database.query(`
      UPDATE shard_placement_authority_revocations
      SET reason_code = 'candidate_retired'
      WHERE authorization_id_sha256 = ?
    `).run(row.authorization_id_sha256)).toThrow(
      "placement authority revocations are immutable",
    );
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_revocations
      WHERE authorization_id_sha256 = ?
    `).run(row.authorization_id_sha256)).toThrow(
      "placement authority revocations are append-preserved",
    );
  });

  test("rejects production, stale, colliding, and cross-key rows", () => {
    for (const mutate of [
      (row) => ({ ...row, environment: "production" }),
      (row) => ({
        ...row,
        permit_expires_at: row.permit_issued_at + 59,
      }),
      (row) => ({
        ...row,
        execution_nonce_sha256: row.authorization_id_sha256,
      }),
      (row) => ({
        ...row,
        operations_spki_sha256: row.security_spki_sha256,
      }),
      (row) => ({
        ...row,
        security_expires_at: row.permit_expires_at - 1,
      }),
    ]) {
      using database = new Database(":memory:");
      database.exec("PRAGMA foreign_keys = ON");
      database.exec(migrationSql);
      expect(() => insertIssuance(
        database,
        mutate(validIssuance()),
      )).toThrow();
    }
  });

  test("installs and enforces the execution lease and receipt ledger", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);

    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);

    const claimed = readExecutionClaim(database);
    expect(claimed).toMatchObject({
      status: "claimed",
      ledger_version: 1,
      last_completed_ordinal: 3,
      enable_intent_seen: 0,
      disable_confirmed: 1,
      ticket_activation_confirmed: 0,
    });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_execution_receipts
    `).get().count).toBe(1);

    insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 2,
      eventKind: "operation_started",
      operationOrdinal: 4,
      operationIdSha256: "4".repeat(64),
      operationKind: "activate_execution_ticket",
      predecessorReceiptSha256: "b".repeat(64),
      requestSha256: "c".repeat(64),
      responseSha256: null,
      evidenceSha256: "d".repeat(64),
      outcome: "pending",
      leaseOwnerSha256: claimed.lease_owner_sha256,
      leaseTokenSha256: claimed.lease_token_sha256,
      leaseGeneration: claimed.lease_generation,
      leaseExpiresAt: claimed.lease_expires_at,
      receiptDigestSha256: "e".repeat(64),
    });
    expect(readExecutionClaim(database)).toMatchObject({
      status: "running",
      ledger_version: 2,
      inflight_operation_ordinal: 4,
      enable_intent_seen: 0,
      disable_confirmed: 1,
    });
    insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 3,
      eventKind: "operation_terminal",
      operationOrdinal: 4,
      operationIdSha256: "4".repeat(64),
      operationKind: "activate_execution_ticket",
      predecessorReceiptSha256: "e".repeat(64),
      requestSha256: "c".repeat(64),
      responseSha256: "f".repeat(64),
      evidenceSha256: "d".repeat(64),
      outcome: "exact_success",
      leaseOwnerSha256: claimed.lease_owner_sha256,
      leaseTokenSha256: claimed.lease_token_sha256,
      leaseGeneration: claimed.lease_generation,
      leaseExpiresAt: claimed.lease_expires_at,
      receiptDigestSha256: "1".repeat(64),
    });
    expect(readExecutionClaim(database)).toMatchObject({
      status: "running",
      ledger_version: 3,
      last_completed_ordinal: 4,
      inflight_operation_ordinal: null,
      application_activation_digest_sha256: "d".repeat(64),
      ticket_activation_confirmed: 1,
    });

    database.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      issuance.authorization_id_sha256,
      issuance.permit_subject_digest_sha256,
      "f".repeat(64),
      "0".repeat(64),
      "2".repeat(64),
    );
    expect(readExecutionClaim(database)).toMatchObject({
      status: "revoked",
      inflight_operation_ordinal: null,
      inflight_readback_only: 0,
    });
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_execution_receipts
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256)).toThrow(
      "placement execution receipts are append-preserved",
    );
  });

  test("rejects operation-4 terminal when revocation races application readback", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claimed = readExecutionClaim(database);
    insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 2,
      eventKind: "operation_started",
      operationOrdinal: 4,
      operationIdSha256: "4".repeat(64),
      operationKind: "activate_execution_ticket",
      predecessorReceiptSha256: "b".repeat(64),
      requestSha256: "c".repeat(64),
      responseSha256: null,
      evidenceSha256: "d".repeat(64),
      outcome: "pending",
      leaseOwnerSha256: claimed.lease_owner_sha256,
      leaseTokenSha256: claimed.lease_token_sha256,
      leaseGeneration: claimed.lease_generation,
      leaseExpiresAt: claimed.lease_expires_at,
      receiptDigestSha256: "e".repeat(64),
    });
    database.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      issuance.authorization_id_sha256,
      issuance.permit_subject_digest_sha256,
      "f".repeat(64),
      "0".repeat(64),
      "2".repeat(64),
    );
    expect(readExecutionClaim(database)).toMatchObject({
      status: "revoked",
      inflight_operation_ordinal: 4,
      ticket_activation_confirmed: 0,
    });
    expect(() => insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 3,
      eventKind: "operation_terminal",
      operationOrdinal: 4,
      operationIdSha256: "4".repeat(64),
      operationKind: "activate_execution_ticket",
      predecessorReceiptSha256: "e".repeat(64),
      requestSha256: "c".repeat(64),
      responseSha256: "f".repeat(64),
      evidenceSha256: "d".repeat(64),
      outcome: "exact_success",
      leaseOwnerSha256: claimed.lease_owner_sha256,
      leaseTokenSha256: claimed.lease_token_sha256,
      leaseGeneration: claimed.lease_generation,
      leaseExpiresAt: claimed.lease_expires_at,
      receiptDigestSha256: "1".repeat(64),
    })).toThrow(
      "placement execution terminal is not an exact readback",
    );
    expect(readExecutionClaim(database)).toMatchObject({
      status: "revoked",
      ledger_version: 2,
      ticket_activation_confirmed: 0,
      application_activation_digest_sha256: null,
    });
  });

  test("takes over only an expired lease and permanently fences the old owner", () => {
    using database = new Database(":memory:");
    const issuance = validIssuance();
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);

    const original = readExecutionClaim(database);
    const takeover = {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 2,
      eventKind: "lease_taken_over",
      operationOrdinal: 3,
      operationIdSha256: "c".repeat(64),
      operationKind: "create_authority_claim",
      predecessorReceiptSha256: "b".repeat(64),
      requestSha256: "c".repeat(64),
      responseSha256: null,
      evidenceSha256: "d".repeat(64),
      outcome: "exact_success",
      leaseOwnerSha256: "e".repeat(64),
      leaseTokenSha256: "f".repeat(64),
      leaseGeneration: 2,
      leaseExpiresAt: original.lease_expires_at + 60,
      receiptDigestSha256: "0".repeat(64),
    };
    expect(() => insertExecutionReceipt(database, takeover)).toThrow(
      "placement execution lease takeover is invalid",
    );

    const projectionGuard = database.query(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name =
          'shard_placement_authority_execution_claim_projection_update_guard'
    `).get().sql;
    database.exec(`
      DROP TRIGGER
        shard_placement_authority_execution_claim_projection_update_guard
    `);
    database.query(`
      UPDATE shard_placement_authority_execution_claims
      SET lease_expires_at = unixepoch() - 1
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256);
    database.exec(projectionGuard);
    const expired = readExecutionClaim(database);
    const takeoverExpiresAt = database.query(`
      SELECT unixepoch() + 60 AS expires_at
    `).get().expires_at;
    insertExecutionReceipt(database, {
      ...takeover,
      leaseExpiresAt: takeoverExpiresAt,
    });
    const takenOver = readExecutionClaim(database);
    expect(takenOver).toMatchObject({
      status: "claimed",
      lease_owner_sha256: "e".repeat(64),
      lease_token_sha256: "f".repeat(64),
      lease_generation: 2,
      takeover_count: 1,
      ledger_version: 2,
      ledger_head_sha256: "0".repeat(64),
    });

    expect(() => insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 3,
      eventKind: "operation_started",
      operationOrdinal: 4,
      operationIdSha256: "4".repeat(64),
      operationKind: "activate_execution_ticket",
      predecessorReceiptSha256: "0".repeat(64),
      requestSha256: "1".repeat(64),
      responseSha256: null,
      evidenceSha256: "2".repeat(64),
      outcome: "pending",
      leaseOwnerSha256: original.lease_owner_sha256,
      leaseTokenSha256: original.lease_token_sha256,
      leaseGeneration: 1,
      leaseExpiresAt: expired.lease_expires_at,
      receiptDigestSha256: "4".repeat(64),
    })).toThrow("placement execution operation start is invalid");

    expect(() => insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 3,
      eventKind: "operation_started",
      operationOrdinal: 4,
      operationIdSha256: "4".repeat(64),
      operationKind: "activate_execution_ticket",
      predecessorReceiptSha256: "0".repeat(64),
      requestSha256: "1".repeat(64),
      responseSha256: null,
      evidenceSha256: "2".repeat(64),
      outcome: "pending",
      leaseOwnerSha256: takenOver.lease_owner_sha256,
      leaseTokenSha256: takenOver.lease_token_sha256,
      leaseGeneration: takenOver.lease_generation,
      leaseExpiresAt: takenOver.lease_expires_at,
      receiptDigestSha256: "4".repeat(64),
    })).toThrow("placement execution operation start is invalid");
  });
});

function validIssuance() {
  const now = Math.floor(Date.now() / 1_000);
  return {
    authorization_id_sha256: "1".repeat(64),
    execution_nonce_sha256: "2".repeat(64),
    campaign_id: "3".repeat(64),
    campaign_nonce_sha256: "4".repeat(64),
    permit_subject_digest_sha256: "5".repeat(64),
    issuance_request_sha256: "6".repeat(64),
    approvals_digest_sha256: "7".repeat(64),
    policy_id: "placement-policy-test-v1",
    policy_sha256: "8".repeat(64),
    permit_issuer: "placement-permit-test",
    permit_key_id: "permit-test-v1",
    permit_signer_spki_sha256: "9".repeat(64),
    environment: "staging",
    controller_service_name:
      "cinatoken-container-controller-staging",
    controller_version_id: "controller-test-v1",
    action_gate_inventory_sha256: "a".repeat(64),
    foundation_manifest_sha256: "b".repeat(64),
    runtime_build_id: "c".repeat(64),
    ring_generation: 19,
    shard_count: 8,
    campaign_lifetime_seconds: 300,
    permit_issued_at: now - 5,
    permit_expires_at: now + 300,
    security_key_id: "security-test-v1",
    security_spki_sha256: "d".repeat(64),
    security_signed_at: now,
    security_expires_at: now + 360,
    operations_key_id: "operations-test-v1",
    operations_spki_sha256: "e".repeat(64),
    operations_signed_at: now,
    operations_expires_at: now + 360,
    release_key_id: "release-test-v1",
    release_spki_sha256: "f".repeat(64),
    release_signed_at: now,
    release_expires_at: now + 360,
    rollback_key_id: "rollback-test-v1",
    rollback_spki_sha256: "0".repeat(64),
    rollback_signed_at: now,
    rollback_expires_at: now + 360,
    issue_credential_id_sha256: "1".repeat(64),
    authority_version_id: "authority-test-v1",
  };
}

function insertIssuance(database, row) {
  const columns = Object.keys(row);
  database.query(`
    INSERT INTO shard_placement_authority_issuances (
      ${columns.join(", ")}
    ) VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => row[column]));
}

function insertExecutionClaim(database, issuance) {
  database.query(`
    INSERT INTO shard_placement_authority_execution_claims (
      authorization_id_sha256, permit_subject_digest_sha256,
      execution_nonce_sha256, application_ticket_id_sha256,
      application_ticket_digest_sha256,
      application_database_identity_sha256,
      authority_database_identity_sha256,
      campaign_id, campaign_nonce_sha256,
      claim_scope, execution_plan_sha256, release_sha256,
      publication_sha256, execution_activation_sha256,
      runner_build_sha256, claim_owner_sha256, lease_owner_sha256,
      ledger_identity_sha256, lease_token_sha256, lease_generation,
      lease_expires_at, baseline_operation_id_sha256,
      baseline_terminal_digest_sha256, preparation_operation_id_sha256,
      claim_operation_id_sha256,
      operation_schedule_sha256, claim_credential_id_sha256,
      claim_request_id_sha256, claim_digest_sha256,
      claim_acquired_receipt_digest_sha256, permit_expires_at,
      normal_deadline_at, recovery_deadline_at, ledger_head_sha256,
      generated_at, claimed_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'staging-controller-placement-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
      unixepoch() + 60, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      unixepoch(), unixepoch(), unixepoch()
    )
  `).run(
    issuance.authorization_id_sha256,
    issuance.permit_subject_digest_sha256,
    issuance.execution_nonce_sha256,
    "c".repeat(64),
    "d".repeat(64),
    "e".repeat(64),
    "f".repeat(64),
    issuance.campaign_id,
    issuance.campaign_nonce_sha256,
    "6".repeat(64),
    "7".repeat(64),
    "8".repeat(64),
    "9".repeat(64),
    "a".repeat(64),
    "1".repeat(64),
    "1".repeat(64),
    "2".repeat(64),
    "3".repeat(64),
    "1".repeat(64),
    "a".repeat(64),
    "3".repeat(64),
    "c".repeat(64),
    "4".repeat(64),
    "5".repeat(64),
    "6".repeat(64),
    "8".repeat(64),
    "b".repeat(64),
    issuance.permit_expires_at,
    issuance.permit_expires_at,
    issuance.permit_expires_at + 600,
    "a".repeat(64),
  );
}

function insertExecutionOperations(database, authorizationIdSha256) {
  for (let ordinal = 4; ordinal <= 14; ordinal += 1) {
    database.query(`
      INSERT INTO shard_placement_authority_execution_operations (
        authorization_id_sha256, ordinal, operation_id_sha256,
        kind, shard_index
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      authorizationIdSha256,
      ordinal,
      ordinal.toString(16).repeat(64),
      ordinal === 4
        ? "activate_execution_ticket"
        : ordinal === 5
          ? "enable_controller_deployment"
          : ordinal === 14
            ? "disable_controller_deployment"
            : "probe_shard_readiness",
      ordinal >= 6 && ordinal <= 13 ? ordinal - 6 : null,
    );
  }
}

function insertExecutionReceipt(database, receipt) {
  database.query(`
    INSERT INTO shard_placement_authority_execution_receipts (
      authorization_id_sha256, sequence, event_kind,
      claim_digest_sha256, execution_plan_sha256,
      ledger_identity_sha256, operation_ordinal,
      operation_id_sha256, operation_kind, shard_index,
      predecessor_receipt_sha256, request_sha256, response_sha256,
      cloudflare_request_id_sha256, evidence_sha256, safety_reason,
      outcome, lease_owner_sha256, lease_token_sha256,
      lease_generation, lease_expires_at,
      receipt_credential_id_sha256, request_id_sha256,
      receipt_digest_sha256
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    receipt.authorizationIdSha256,
    receipt.sequence,
    receipt.eventKind,
    "8".repeat(64),
    "6".repeat(64),
    "2".repeat(64),
    receipt.operationOrdinal,
    receipt.operationIdSha256,
    receipt.operationKind,
    receipt.predecessorReceiptSha256,
    receipt.requestSha256,
    receipt.responseSha256,
    receipt.evidenceSha256,
    receipt.outcome,
    receipt.leaseOwnerSha256,
    receipt.leaseTokenSha256,
    receipt.leaseGeneration,
    receipt.leaseExpiresAt,
    "9".repeat(64),
    "0".repeat(64),
    receipt.receiptDigestSha256,
  );
}

function readExecutionClaim(database) {
  return database.query(`
    SELECT *
    FROM shard_placement_authority_execution_claims
    LIMIT 1
  `).get();
}
