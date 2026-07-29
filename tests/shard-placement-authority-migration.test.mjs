import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  executionRepositorySqlForTest,
} from "../services/shard-placement-authority/src/execution_repository.ts";

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
const dispatchConsumptionMigrationSql = readFileSync(join(
  import.meta.dir,
  "..",
  "services",
  "shard-placement-authority",
  "migrations",
  "0003_shard_placement_dispatch_consumptions.sql",
), "utf8");
const dispatchConsumptionRecoveryMigrationSql = readFileSync(join(
  import.meta.dir,
  "..",
  "services",
  "shard-placement-authority",
  "migrations",
  "0004_shard_placement_dispatch_consumption_recoveries.sql",
), "utf8");

const RECOVERY_TRIGGER_DIGESTS = {
  shard_placement_authority_operation_five_dispatch_consumption_insert_guard:
    "0e1178ab5d0f33c06467f358d21ed6ac1b6e24045170f035321ef961b9f9964b",
  shard_placement_authority_operation_five_dispatch_consumption_recovery_delete_guard:
    "59abc0483b086e5b0f7c5bcacbff078ddb04e11aa918f3371f8ed342756f4ee5",
  shard_placement_authority_operation_five_dispatch_consumption_recovery_insert_guard:
    "7580be7d81ff9087d8a4a019042a93f4922291946db8b106444a8d78050540aa",
  shard_placement_authority_operation_five_dispatch_consumption_recovery_update_guard:
    "64dd60b10f3e27fe32bdc1dd890180eb9ea128213e45416051a922bd30c2123b",
};

describe("shard placement Authority migration", () => {
  test("keeps the migration inventory exact", () => {
    expect(readdirSync(join(
      import.meta.dir,
      "..",
      "services",
      "shard-placement-authority",
      "migrations",
    )).filter((name) => name.endsWith(".sql")).sort()).toEqual([
      "0001_shard_placement_authorizations.sql",
      "0002_shard_placement_execution_claims.sql",
      "0003_shard_placement_dispatch_consumptions.sql",
      "0004_shard_placement_dispatch_consumption_recoveries.sql",
      "0005_operation_five_send_attempts.sql",
      "0006_operation_five_gateway_events.sql",
      "0007_operation_five_terminal_receipts.sql",
      "0008_operation_readiness_receipts.sql",
      "0009_operation_fourteen_disable_receipts.sql",
    ]);
  });

  test("installs the complete operation-readiness catalog with valid foreign keys", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    const migrationsDirectory = join(
      import.meta.dir,
      "..",
      "services",
      "shard-placement-authority",
      "migrations",
    );
    for (const name of readdirSync(migrationsDirectory)
      .filter((candidate) => candidate.endsWith(".sql"))
      .sort()) {
      database.exec(readFileSync(join(
        migrationsDirectory,
        name,
      ), "utf8"));
    }

    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query(`
      SELECT type || ':' || name AS identity
      FROM sqlite_master
      WHERE name LIKE
        'shard_placement_authority_operation_readiness_%'
      ORDER BY identity
    `).all().map((row) => row.identity)).toEqual([
      "table:shard_placement_authority_operation_readiness_attempts",
      "table:shard_placement_authority_operation_readiness_terminals",
      "trigger:shard_placement_authority_operation_readiness_attempt_delete_guard",
      "trigger:shard_placement_authority_operation_readiness_attempt_insert_guard",
      "trigger:shard_placement_authority_operation_readiness_attempt_update_guard",
      "trigger:shard_placement_authority_operation_readiness_terminal_delete_guard",
      "trigger:shard_placement_authority_operation_readiness_terminal_insert_guard",
      "trigger:shard_placement_authority_operation_readiness_terminal_update_guard",
    ]);
    expect(database.query(`
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_readiness_attempts'
      )
      ORDER BY cid
    `).all().map((row) => row.name)).toEqual(expect.arrayContaining([
      "dispatch_mode",
      "wake_attempt_limit",
      "wake_retry_limit",
      "missing_readback_allows_resend",
      "probe_deadline_at_ms",
      "operation_start_receipt_digest_sha256",
    ]));
    expect(database.query(`
      SELECT name
      FROM pragma_table_info(
        'shard_placement_authority_operation_readiness_terminals'
      )
      ORDER BY cid
    `).all().map((row) => row.name)).toEqual(expect.arrayContaining([
      "result_outcome",
      "recovery_mode",
      "process_ready",
      "execution_ready",
      "runtime_execution_enabled",
      "controller_execution_enabled",
      "generic_terminal_receipt_digest_sha256",
    ]));
  });

  test("installs and enforces operation-14 append-only sidecars", () => {
    using database = new Database(":memory:");
    installAllAuthorityMigrations(database);

    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query(`
      SELECT type || ':' || name AS identity
      FROM sqlite_master
      WHERE name LIKE
        'shard_placement_authority_operation_fourteen_%'
      ORDER BY identity
    `).all().map((row) => row.identity)).toEqual([
      "table:shard_placement_authority_operation_fourteen_attempts",
      "table:shard_placement_authority_operation_fourteen_gateway_events",
      "table:shard_placement_authority_operation_fourteen_terminals",
      "trigger:shard_placement_authority_operation_fourteen_attempt_delete_guard",
      "trigger:shard_placement_authority_operation_fourteen_attempt_insert_guard",
      "trigger:shard_placement_authority_operation_fourteen_attempt_update_guard",
      "trigger:shard_placement_authority_operation_fourteen_gateway_event_delete_guard",
      "trigger:shard_placement_authority_operation_fourteen_gateway_event_insert_guard",
      "trigger:shard_placement_authority_operation_fourteen_gateway_event_update_guard",
      "trigger:shard_placement_authority_operation_fourteen_receipt_sidecar_guard",
      "trigger:shard_placement_authority_operation_fourteen_terminal_delete_guard",
      "trigger:shard_placement_authority_operation_fourteen_terminal_insert_guard",
      "trigger:shard_placement_authority_operation_fourteen_terminal_update_guard",
    ]);

    expect(tableColumns(
      database,
      "shard_placement_authority_operation_fourteen_attempts",
    )).toEqual(expect.arrayContaining([
      "ledger_version_before",
      "operation_start_sequence",
      "operation_five_terminal_receipt_sha256",
      "operation_five_send_attempt_digest_sha256",
      "controller_enabled_source_version_id",
      "controller_baseline_target_version_id",
      "authority_command_digest_sha256",
      "gateway_command_digest_sha256",
      "gateway_idempotency_key_sha256",
      "gateway_create_credential_id_sha256",
      "gateway_status_credential_id_sha256",
      "expected_gateway_version_id",
      "disable_deadline_at",
      "mutation_attempt_limit",
      "retry_limit",
      "missing_readback_allows_resend",
      "operation_start_receipt_digest_sha256",
      "disable_dispatched_event_digest_sha256",
    ]));
    expect(tableColumns(
      database,
      "shard_placement_authority_operation_fourteen_gateway_events",
    )).toEqual(expect.arrayContaining([
      "event_sequence",
      "event_kind",
      "dispatch_semantics",
      "credential_role",
      "predecessor_event_digest_sha256",
      "event_digest_sha256",
      "deployment_set_sha256",
      "observation_digest_sha256",
    ]));
    expect(tableColumns(
      database,
      "shard_placement_authority_operation_fourteen_terminals",
    )).toEqual(expect.arrayContaining([
      "terminal_event_sequence",
      "terminal_event_digest_sha256",
      "terminal_event_kind",
      "attempt_lease_owner_sha256",
      "attempt_lease_token_sha256",
      "attempt_lease_generation",
      "result_outcome",
      "recovery_mode",
      "ledger_version_before",
      "generic_receipt_sequence",
      "generic_terminal_receipt_digest_sha256",
    ]));

    const attemptForeignKeys = database.query(`
      SELECT "table" AS parent_table, "from" AS child_column,
             "to" AS parent_column
      FROM pragma_foreign_key_list(
        'shard_placement_authority_operation_fourteen_attempts'
      )
    `).all();
    expect(attemptForeignKeys).toEqual(expect.arrayContaining([
      {
        parent_table:
          "shard_placement_authority_operation_five_terminals",
        child_column: "operation_five_terminal_receipt_sha256",
        parent_column: "generic_terminal_receipt_digest_sha256",
      },
      {
        parent_table:
          "shard_placement_authority_operation_five_send_attempts",
        child_column: "operation_five_send_attempt_digest_sha256",
        parent_column: "attempt_digest_sha256",
      },
      {
        parent_table: "shard_placement_authority_execution_receipts",
        child_column: "operation_start_receipt_digest_sha256",
        parent_column: "receipt_digest_sha256",
      },
      {
        parent_table:
          "shard_placement_authority_operation_fourteen_gateway_events",
        child_column: "disable_dispatched_event_digest_sha256",
        parent_column: "event_digest_sha256",
      },
    ]));

    const attemptGuard = triggerSql(
      database,
      "shard_placement_authority_operation_fourteen_attempt_insert_guard",
    );
    expect(attemptGuard).toContain("claim.ledger_version <= 52");
    expect(attemptGuard).toContain(
      "NEW.operation_start_sequence =\n              claim.ledger_version + 1",
    );
    const receiptGuard = triggerSql(
      database,
      "shard_placement_authority_operation_fourteen_receipt_sidecar_guard",
    );
    expect(receiptGuard).toContain(
      "operation_fourteen_started_receipt_sidecar_mismatch",
    );
    expect(receiptGuard).toContain(
      "operation_fourteen_terminal_receipt_sidecar_mismatch",
    );
    expect(receiptGuard).toContain(
      "NEW.event_kind IN ('operation_started', 'operation_terminal')",
    );
  });

  test("projects dynamic operation-14 receipts and blocks generic bypass", () => {
    using database = new Database(":memory:");
    installAllAuthorityMigrations(database);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    forceOperationFourteenClaim(database, issuance.authorization_id_sha256);
    const claim = readExecutionClaim(database);

    expect(() => insertExecutionReceipt(database, {
      authorizationIdSha256: issuance.authorization_id_sha256,
      sequence: 6,
      eventKind: "operation_started",
      operationOrdinal: 14,
      operationIdSha256: "e".repeat(64),
      operationKind: "disable_controller_deployment",
      predecessorReceiptSha256: claim.ledger_head_sha256,
      requestSha256: "1".repeat(64),
      responseSha256: null,
      evidenceSha256: "2".repeat(64),
      outcome: "pending",
      leaseOwnerSha256: claim.lease_owner_sha256,
      leaseTokenSha256: claim.lease_token_sha256,
      leaseGeneration: claim.lease_generation,
      leaseExpiresAt: claim.lease_expires_at,
      receiptCredentialIdSha256: "3".repeat(64),
      requestIdSha256: "4".repeat(64),
      receiptDigestSha256: "5".repeat(64),
    })).toThrow(
      "operation_fourteen_started_receipt_sidecar_mismatch",
    );

    const fixture = operationFourteenSqliteFixture(database, issuance);
    expect(readExecutionClaim(database)).toMatchObject({
      status: "disable_required",
      ledger_version: 6,
      ledger_head_sha256:
        fixture.attempt.operation_start_receipt_digest_sha256,
      inflight_operation_ordinal: 14,
      inflight_operation_id_sha256:
        fixture.attempt.operation_id_sha256,
      inflight_request_sha256:
        fixture.attempt.operation_request_sha256,
    });
    expect(fixture.attempt.operation_start_sequence).toBe(6);

    appendOperationFourteenRejectedEvent(database, fixture);
    completeOperationFourteenRejected(database, fixture);
    expect(readExecutionClaim(database)).toMatchObject({
      status: "recovery_required",
      ledger_version: 7,
      ledger_head_sha256:
        fixture.terminal.generic_terminal_receipt_digest_sha256,
      last_completed_ordinal: 5,
      inflight_operation_ordinal: null,
      disable_confirmed: 0,
    });
    expect(fixture.terminal.generic_receipt_sequence).toBe(7);

    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_fourteen_attempts
      SET authority_version_id = 'changed'
    `).run()).toThrow("immutable_operation_fourteen_attempt");
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_operation_fourteen_attempts
    `).run()).toThrow("append_preserved_operation_fourteen_attempt");
    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_fourteen_gateway_events
      SET event_kind = 'mutation_unknown'
    `).run()).toThrow("immutable_operation_fourteen_gateway_event");
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_operation_fourteen_gateway_events
    `).run()).toThrow(
      "append_preserved_operation_fourteen_gateway_event",
    );
    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_fourteen_terminals
      SET recovery_mode = 'readback_only'
    `).run()).toThrow("immutable_operation_fourteen_terminal");
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_operation_fourteen_terminals
    `).run()).toThrow(
      "append_preserved_operation_fourteen_terminal",
    );
  });

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

  test("atomically fences operation 5 with ACK admission and revocation", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claim = completeOperationFour(database, issuance);
    const admission = operationFiveAdmission(issuance);
    const start = operationFiveStart(issuance, claim, admission);

    expect(() => insertExecutionReceipt(database, start)).toThrow(
      "placement execution operation start is invalid",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_admissions
    `).get().count).toBe(0);

    database.transaction(() => {
      insertOperationFiveAdmission(database, admission);
      insertExecutionReceipt(database, start);
    })();
    expect(readExecutionClaim(database)).toMatchObject({
      status: "running",
      ledger_version: 4,
      inflight_operation_ordinal: 5,
      enable_intent_seen: 1,
      disable_confirmed: 0,
    });
    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_five_admissions
      SET authority_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256)).toThrow(
      "placement operation-five admissions are immutable",
    );
  });

  test("prepares and append-preserves the exact operation-5 dispatch outbox", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claim = completeOperationFour(database, issuance);
    const admission = operationFiveAdmission(issuance);
    const start = operationFiveStart(issuance, claim, admission);

    database.transaction(() => {
      insertOperationFiveAdmission(database, admission);
      insertExecutionReceipt(database, start);
    })();
    const outbox = operationFiveDispatchOutbox(
      database,
      issuance,
      admission,
    );
    insertOperationFiveDispatchOutbox(database, outbox);

    const stored = database.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_dispatch_outbox
      WHERE authorization_id_sha256 = ?
    `).get(issuance.authorization_id_sha256);
    const storedAdmission = database.query(`
      SELECT confirmed_at
      FROM shard_placement_authority_operation_five_admissions
      WHERE authorization_id_sha256 = ?
    `).get(issuance.authorization_id_sha256);
    expect(stored).toMatchObject({
      ...outbox,
      contract_version: 1,
      outbox_state: "prepared",
    });
    expect(stored.prepared_at).toBeGreaterThanOrEqual(
      storedAdmission.confirmed_at,
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_dispatch_outbox
    `).get().count).toBe(1);

    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_five_dispatch_outbox
      SET authority_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256)).toThrow(
      "placement operation-five dispatch outbox is immutable",
    );
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_operation_five_dispatch_outbox
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256)).toThrow(
      "placement operation-five dispatch outbox is append-preserved",
    );
    expect(database.query(`
      SELECT outbox_state, authority_version_id
      FROM shard_placement_authority_operation_five_dispatch_outbox
      WHERE authorization_id_sha256 = ?
    `).get(issuance.authorization_id_sha256)).toEqual({
      outbox_state: "prepared",
      authority_version_id: outbox.authority_version_id,
    });
  });

  test("rejects operation-5 dispatch outbox prerequisite and revocation races", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claim = completeOperationFour(database, issuance);
    const admission = operationFiveAdmission(issuance);
    const start = operationFiveStart(issuance, claim, admission);
    const outbox = operationFiveDispatchOutbox(
      database,
      issuance,
      admission,
    );

    expect(() => insertOperationFiveDispatchOutbox(
      database,
      outbox,
    )).toThrow();
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_dispatch_outbox
    `).get().count).toBe(0);

    insertOperationFiveAdmission(database, admission);
    expect(() => insertOperationFiveDispatchOutbox(
      database,
      outbox,
    )).toThrow(
      "placement operation-five dispatch outbox is not admissible",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_dispatch_outbox
    `).get().count).toBe(0);

    insertExecutionReceipt(database, start);
    database.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      issuance.authorization_id_sha256,
      issuance.permit_subject_digest_sha256,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
    );
    expect(() => insertOperationFiveDispatchOutbox(
      database,
      outbox,
    )).toThrow(
      "placement operation-five dispatch outbox is not admissible",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_dispatch_outbox
    `).get().count).toBe(0);
  });

  test("records and append-preserves the exact application pre-enable grant", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claim = completeOperationFour(database, issuance);
    const admission = operationFiveAdmission(issuance);
    const start = operationFiveStart(issuance, claim, admission);

    database.transaction(() => {
      insertOperationFiveAdmission(database, admission);
      insertExecutionReceipt(database, start);
    })();
    const outbox = operationFiveDispatchOutbox(
      database,
      issuance,
      admission,
    );
    insertOperationFiveDispatchOutbox(database, outbox);
    const grant = operationFiveApplicationGrant(
      database,
      issuance,
      outbox,
    );
    insertOperationFiveApplicationGrant(database, grant);

    const stored = database.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_application_grants
      WHERE authorization_id_sha256 = ?
    `).get(issuance.authorization_id_sha256);
    const preparedAt = database.query(`
      SELECT prepared_at
      FROM shard_placement_authority_operation_five_dispatch_outbox
      WHERE authorization_id_sha256 = ?
    `).get(issuance.authorization_id_sha256).prepared_at;
    expect(stored).toMatchObject({
      ...grant,
      contract_version: 1,
    });
    expect(stored.recorded_at).toBeGreaterThanOrEqual(preparedAt);
    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_five_application_grants
      SET application_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256)).toThrow(
      "placement operation-five application grants are immutable",
    );
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_operation_five_application_grants
      WHERE authorization_id_sha256 = ?
    `).run(issuance.authorization_id_sha256)).toThrow(
      "placement operation-five application grants are append-preserved",
    );
  });

  test("rejects application grants before outbox and after revocation", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claim = completeOperationFour(database, issuance);
    const admission = operationFiveAdmission(issuance);
    const start = operationFiveStart(issuance, claim, admission);
    database.transaction(() => {
      insertOperationFiveAdmission(database, admission);
      insertExecutionReceipt(database, start);
    })();
    const outbox = operationFiveDispatchOutbox(
      database,
      issuance,
      admission,
    );
    const grant = operationFiveApplicationGrant(
      database,
      issuance,
      outbox,
    );

    expect(() => insertOperationFiveApplicationGrant(
      database,
      grant,
    )).toThrow();
    insertOperationFiveDispatchOutbox(database, outbox);
    database.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      issuance.authorization_id_sha256,
      issuance.permit_subject_digest_sha256,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
    );
    expect(() => insertOperationFiveApplicationGrant(
      database,
      grant,
    )).toThrow(
      "placement operation-five application grant is not admissible",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_application_grants
    `).get().count).toBe(0);
  });

  test("claims operation-5 dispatch once and append-preserves the claim", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const prepared = prepareOperationFiveApplicationGrant(database);
    const dispatchClaim = operationFiveDispatchClaim(database, prepared);

    expect(database.query(`
      PRAGMA table_info(
        'shard_placement_authority_operation_five_dispatch_claims'
      )
    `).all().map((column) => column.name)).toEqual([
      "authorization_id_sha256",
      "contract_version",
      "claim_contract",
      "claim_digest_sha256",
      "application_ticket_id_sha256",
      "application_database_identity_sha256",
      "authority_dispatch_outbox_digest_sha256",
      "application_grant_receipt_digest_sha256",
      "application_grant_digest_sha256",
      "operation_five_start_receipt_sha256",
      "authority_database_identity_sha256",
      "authority_ledger_identity_sha256",
      "authority_ledger_head_sha256",
      "authority_version_id",
      "application_version_id",
      "dispatch_owner_sha256",
      "lease_token_sha256",
      "lease_generation",
      "lease_expires_at",
      "normal_deadline_at",
      "permit_expires_at",
      "dispatch_claim_credential_id_sha256",
      "dispatch_claim_request_id_sha256",
      "command_dispatch_claim_request_id_sha256",
      "controller_service_name",
      "controller_enable_operation_id_sha256",
      "controller_baseline_version_id",
      "controller_enabled_version_id",
      "send_attempt_limit",
      "retry_limit",
      "missing_readback_allows_resend",
      "dispatch_claim_digest_sha256",
      "claim_state",
      "claimed_at",
    ]);

    insertOperationFiveDispatchClaim(database, dispatchClaim);
    const stored = database.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_dispatch_claims
      WHERE authorization_id_sha256 = ?
    `).get(prepared.issuance.authorization_id_sha256);
    expect(stored).toMatchObject(dispatchClaim);
    expect(stored.claimed_at).toBeGreaterThanOrEqual(
      prepared.applicationGrant.recorded_at,
    );

    expect(() => insertOperationFiveDispatchClaim(
      database,
      dispatchClaim,
    )).toThrow("UNIQUE constraint failed");
    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_five_dispatch_claims
      SET authority_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `).run(prepared.issuance.authorization_id_sha256)).toThrow(
      "placement operation-five dispatch claims are immutable",
    );
    expect(() => database.query(`
      DELETE FROM shard_placement_authority_operation_five_dispatch_claims
      WHERE authorization_id_sha256 = ?
    `).run(prepared.issuance.authorization_id_sha256)).toThrow(
      "placement operation-five dispatch claims are append-preserved",
    );
  });

  test("rejects operation-5 dispatch claims before grant and after revocation", () => {
    using preGrantDatabase = new Database(":memory:");
    preGrantDatabase.exec("PRAGMA foreign_keys = ON");
    preGrantDatabase.exec(migrationSql);
    preGrantDatabase.exec(executionMigrationSql);
    const preGrant = prepareOperationFiveApplicationGrant(
      preGrantDatabase,
      false,
    );
    expect(() => insertOperationFiveDispatchClaim(
      preGrantDatabase,
      operationFiveDispatchClaim(preGrantDatabase, preGrant),
    )).toThrow(
      "placement operation-five dispatch claim is not admissible",
    );

    using revokedDatabase = new Database(":memory:");
    revokedDatabase.exec("PRAGMA foreign_keys = ON");
    revokedDatabase.exec(migrationSql);
    revokedDatabase.exec(executionMigrationSql);
    const revoked = prepareOperationFiveApplicationGrant(revokedDatabase);
    revokedDatabase.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      revoked.issuance.authorization_id_sha256,
      revoked.issuance.permit_subject_digest_sha256,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
    );
    expect(() => insertOperationFiveDispatchClaim(
      revokedDatabase,
      operationFiveDispatchClaim(revokedDatabase, revoked),
    )).toThrow(
      "placement operation-five dispatch claim is not admissible",
    );
  });

  test("rejects expired and owner-drifted operation-5 dispatch claims", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const prepared = prepareOperationFiveApplicationGrant(database);
    const dispatchClaim = operationFiveDispatchClaim(database, prepared);

    expect(() => insertOperationFiveDispatchClaim(database, {
      ...dispatchClaim,
      dispatch_owner_sha256: "f".repeat(64),
    })).toThrow(
      "placement operation-five dispatch claim is not admissible",
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
    `).run(prepared.issuance.authorization_id_sha256);
    database.exec(projectionGuard);

    expect(() => insertOperationFiveDispatchClaim(
      database,
      operationFiveDispatchClaim(database, prepared),
    )).toThrow(
      "placement operation-five dispatch claim is not admissible",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_dispatch_claims
    `).get().count).toBe(0);
  });

  test("records and append-preserves an Application dispatch consumption", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    database.exec(dispatchConsumptionMigrationSql);
    const prepared = prepareOperationFiveDispatchConsumption(database);
    const receipt = operationFiveDispatchConsumptionReceipt(
      database,
      prepared,
    );

    expect(database.query(`
      PRAGMA table_info(
        'shard_placement_authority_operation_five_dispatch_consumptions'
      )
    `).all().map((column) => column.name)).toEqual([
      "authorization_id_sha256",
      "contract_version",
      "receipt_contract",
      "claim_digest_sha256",
      "application_ticket_id_sha256",
      "campaign_id",
      "application_database_identity_sha256",
      "application_version_id",
      "application_grant_receipt_digest_sha256",
      "application_grant_digest_sha256",
      "authority_dispatch_outbox_digest_sha256",
      "operation_five_start_receipt_sha256",
      "authority_dispatch_claim_digest_sha256",
      "authority_database_identity_sha256",
      "authority_ledger_identity_sha256",
      "authority_ledger_head_sha256",
      "authority_version_id",
      "dispatch_owner_sha256",
      "lease_token_sha256",
      "lease_generation",
      "lease_expires_at",
      "normal_deadline_at",
      "permit_expires_at",
      "dispatch_claim_credential_id_sha256",
      "dispatch_claim_request_id_sha256",
      "command_dispatch_claim_request_id_sha256",
      "authority_dispatch_claimed_at",
      "controller_service_name",
      "controller_enable_operation_id_sha256",
      "controller_baseline_version_id",
      "controller_enabled_version_id",
      "send_attempt_limit",
      "retry_limit",
      "missing_readback_allows_resend",
      "application_dispatch_consumption_digest_sha256",
      "application_dispatch_consumption_credential_id_sha256",
      "application_dispatch_consumption_request_id_sha256",
      "command_dispatch_consumption_request_id_sha256",
      "application_consumption_state",
      "application_consumed_at",
      "application_response_sha256",
      "application_response_bytes",
      "consume_credential_id_sha256",
      "consume_request_id_sha256",
      "command_consume_request_id_sha256",
      "receipt_digest_sha256",
      "recorded_at",
    ]);

    const uniqueColumns = database.query(`
      SELECT info.name
      FROM pragma_index_list(
        'shard_placement_authority_operation_five_dispatch_consumptions'
      ) AS indexes
      JOIN pragma_index_info(indexes.name) AS info
      WHERE indexes.[unique] = 1
    `).all().map((row) => row.name);
    expect(uniqueColumns).not.toContain(
      "dispatch_claim_credential_id_sha256",
    );
    expect(uniqueColumns).not.toContain(
      "application_dispatch_consumption_credential_id_sha256",
    );
    expect(uniqueColumns).not.toContain("consume_credential_id_sha256");

    insertOperationFiveDispatchConsumption(database, receipt);
    const stored = database.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_dispatch_consumptions
      WHERE authorization_id_sha256 = ?
    `).get(prepared.issuance.authorization_id_sha256);
    expect(stored).toMatchObject(receipt);
    expect(stored.recorded_at).toBeGreaterThanOrEqual(
      stored.application_consumed_at,
    );

    expect(() => database.query(`
      UPDATE shard_placement_authority_operation_five_dispatch_consumptions
      SET authority_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `).run(prepared.issuance.authorization_id_sha256)).toThrow(
      "placement operation-five dispatch consumptions are immutable",
    );
    expect(() => database.query(`
      DELETE
      FROM shard_placement_authority_operation_five_dispatch_consumptions
      WHERE authorization_id_sha256 = ?
    `).run(prepared.issuance.authorization_id_sha256)).toThrow(
      "placement operation-five dispatch consumptions are append-preserved",
    );
  });

  test("rejects dispatch consumption before claim and after revocation", () => {
    using preClaimDatabase = new Database(":memory:");
    preClaimDatabase.exec("PRAGMA foreign_keys = ON");
    preClaimDatabase.exec(migrationSql);
    preClaimDatabase.exec(executionMigrationSql);
    preClaimDatabase.exec(dispatchConsumptionMigrationSql);
    const preClaim = prepareOperationFiveDispatchConsumption(
      preClaimDatabase,
      false,
    );
    expect(() => insertOperationFiveDispatchConsumption(
      preClaimDatabase,
      operationFiveDispatchConsumptionReceipt(preClaimDatabase, preClaim),
    )).toThrow(
      "placement operation-five dispatch consumption is not admissible",
    );

    using revokedDatabase = new Database(":memory:");
    revokedDatabase.exec("PRAGMA foreign_keys = ON");
    revokedDatabase.exec(migrationSql);
    revokedDatabase.exec(executionMigrationSql);
    revokedDatabase.exec(dispatchConsumptionMigrationSql);
    const revoked = prepareOperationFiveDispatchConsumption(revokedDatabase);
    revokedDatabase.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      revoked.issuance.authorization_id_sha256,
      revoked.issuance.permit_subject_digest_sha256,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
    );
    expect(() => insertOperationFiveDispatchConsumption(
      revokedDatabase,
      operationFiveDispatchConsumptionReceipt(revokedDatabase, revoked),
    )).toThrow(
      "placement operation-five dispatch consumption is not admissible",
    );
  });

  test("rejects expired and owner-drifted dispatch consumption", () => {
    using ownerDatabase = new Database(":memory:");
    ownerDatabase.exec("PRAGMA foreign_keys = ON");
    ownerDatabase.exec(migrationSql);
    ownerDatabase.exec(executionMigrationSql);
    ownerDatabase.exec(dispatchConsumptionMigrationSql);
    const ownerDrift = prepareOperationFiveDispatchConsumption(ownerDatabase);
    const identityGuard = ownerDatabase.query(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name =
          'shard_placement_authority_execution_claim_identity_update_guard'
    `).get().sql;
    ownerDatabase.exec(`
      DROP TRIGGER
        shard_placement_authority_execution_claim_identity_update_guard
    `);
    ownerDatabase.query(`
      UPDATE shard_placement_authority_execution_claims
      SET claim_owner_sha256 = ?
      WHERE authorization_id_sha256 = ?
    `).run(
      "f".repeat(64),
      ownerDrift.issuance.authorization_id_sha256,
    );
    ownerDatabase.exec(identityGuard);
    expect(() => insertOperationFiveDispatchConsumption(
      ownerDatabase,
      operationFiveDispatchConsumptionReceipt(ownerDatabase, ownerDrift),
    )).toThrow(
      "placement operation-five dispatch consumption is not admissible",
    );

    using expiredDatabase = new Database(":memory:");
    expiredDatabase.exec("PRAGMA foreign_keys = ON");
    expiredDatabase.exec(migrationSql);
    expiredDatabase.exec(executionMigrationSql);
    expiredDatabase.exec(dispatchConsumptionMigrationSql);
    const expired = prepareOperationFiveDispatchConsumption(expiredDatabase);
    const projectionGuard = expiredDatabase.query(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name =
          'shard_placement_authority_execution_claim_projection_update_guard'
    `).get().sql;
    expiredDatabase.exec(`
      DROP TRIGGER
        shard_placement_authority_execution_claim_projection_update_guard
    `);
    expiredDatabase.query(`
      UPDATE shard_placement_authority_execution_claims
      SET lease_expires_at = unixepoch() - 1
      WHERE authorization_id_sha256 = ?
    `).run(expired.issuance.authorization_id_sha256);
    expiredDatabase.exec(projectionGuard);
    expect(() => insertOperationFiveDispatchConsumption(
      expiredDatabase,
      operationFiveDispatchConsumptionReceipt(expiredDatabase, expired),
    )).toThrow(
      "placement operation-five dispatch consumption is not admissible",
    );
  });

  test("enforces claimed-consumed-recorded dispatch consumption ordering", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    database.exec(dispatchConsumptionMigrationSql);
    const prepared = prepareOperationFiveDispatchConsumption(database);
    const receipt = operationFiveDispatchConsumptionReceipt(
      database,
      prepared,
    );

    expect(() => insertOperationFiveDispatchConsumption(database, {
      ...receipt,
      application_consumed_at: receipt.authority_dispatch_claimed_at - 1,
    })).toThrow();
    expect(() => insertOperationFiveDispatchConsumption(database, {
      ...receipt,
      application_consumed_at: receipt.permit_expires_at,
    })).toThrow(
      "placement operation-five dispatch consumption is not admissible",
    );
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_operation_five_dispatch_consumptions
    `).get().count).toBe(0);
  });

  test("installs exact 0001-0004 recovery triggers and rejects a same-name weak guard", () => {
    using database = new Database(":memory:");
    installDispatchConsumptionRecoverySchema(database);

    expect(() => assertRecoveryTriggerDigests(database)).not.toThrow();
    database.exec(`
      DROP TRIGGER
        shard_placement_authority_operation_five_dispatch_consumption_recovery_insert_guard
    `);
    database.exec(`
      CREATE TRIGGER
        shard_placement_authority_operation_five_dispatch_consumption_recovery_insert_guard
      BEFORE INSERT
      ON shard_placement_authority_operation_five_dispatch_consumption_recoveries
      FOR EACH ROW
      BEGIN
        SELECT 1;
      END
    `);
    expect(() => assertRecoveryTriggerDigests(database)).toThrow(
      "Authority recovery trigger digest mismatch",
    );
  });

  test("atomically records historical recovery evidence and its canonical receipt", () => {
    using database = new Database(":memory:");
    installDispatchConsumptionRecoverySchema(database);
    const prepared = prepareOperationFiveDispatchConsumption(database);
    const receipt = operationFiveDispatchConsumptionReceipt(
      database,
      prepared,
    );
    const recovery = operationFiveDispatchConsumptionRecovery(
      database,
      receipt,
    );
    revokeOperationFive(database, prepared);

    database.transaction(() => {
      insertOperationFiveDispatchConsumptionRecovery(database, recovery);
      insertOperationFiveDispatchConsumption(database, receipt);
    })();

    expect(readRecoveryCounts(database)).toEqual({
      receipts: 1,
      recoveries: 1,
    });
    expect(database.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_dispatch_consumption_recoveries
      WHERE authorization_id_sha256 = ?
    `).get(prepared.issuance.authorization_id_sha256)).toMatchObject(
      recovery,
    );
    expect(database.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_dispatch_consumptions
      WHERE authorization_id_sha256 = ?
    `).get(prepared.issuance.authorization_id_sha256)).toMatchObject(
      receipt,
    );

    expectSqliteGuard(database, `
      UPDATE shard_placement_authority_operation_five_dispatch_consumption_recoveries
      SET application_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `, prepared.issuance.authorization_id_sha256,
      "placement operation-five dispatch consumption recoveries are immutable",
    );
    expectSqliteGuard(database, `
      DELETE
      FROM shard_placement_authority_operation_five_dispatch_consumption_recoveries
      WHERE authorization_id_sha256 = ?
    `, prepared.issuance.authorization_id_sha256,
      "placement operation-five dispatch consumption recoveries are append-preserved",
    );
    expectSqliteGuard(database, `
      UPDATE shard_placement_authority_operation_five_dispatch_consumptions
      SET application_version_id = 'replacement'
      WHERE authorization_id_sha256 = ?
    `, prepared.issuance.authorization_id_sha256,
      "placement operation-five dispatch consumptions are immutable",
    );
    expectSqliteGuard(database, `
      DELETE
      FROM shard_placement_authority_operation_five_dispatch_consumptions
      WHERE authorization_id_sha256 = ?
    `, prepared.issuance.authorization_id_sha256,
      "placement operation-five dispatch consumptions are append-preserved",
    );
  });

  test("rolls back recovery evidence when the second batch insert fails", () => {
    using database = new Database(":memory:");
    installDispatchConsumptionRecoverySchema(database);
    const prepared = prepareOperationFiveDispatchConsumption(database);
    const receipt = operationFiveDispatchConsumptionReceipt(
      database,
      prepared,
    );
    const recovery = operationFiveDispatchConsumptionRecovery(
      database,
      receipt,
    );
    revokeOperationFive(database, prepared);

    expect(() => database.transaction(() => {
      insertOperationFiveDispatchConsumptionRecovery(database, recovery);
      insertOperationFiveDispatchConsumption(database, {
        ...receipt,
        receipt_contract: "invalid-receipt-contract",
      });
    })()).toThrow();
    expect(readRecoveryCounts(database)).toEqual({
      receipts: 0,
      recoveries: 0,
    });
  });

  test("keeps one canonical receipt for both live/recovery race serializations", () => {
    using recoveryWins = new Database(":memory:");
    installDispatchConsumptionRecoverySchema(recoveryWins);
    const recovered = prepareOperationFiveDispatchConsumption(recoveryWins);
    const recoveredReceipt = operationFiveDispatchConsumptionReceipt(
      recoveryWins,
      recovered,
    );
    const recovery = operationFiveDispatchConsumptionRecovery(
      recoveryWins,
      recoveredReceipt,
    );
    revokeOperationFive(recoveryWins, recovered);
    recoveryWins.transaction(() => {
      insertOperationFiveDispatchConsumptionRecovery(recoveryWins, recovery);
      insertOperationFiveDispatchConsumption(
        recoveryWins,
        recoveredReceipt,
      );
    })();
    expect(() => insertOperationFiveDispatchConsumption(
      recoveryWins,
      recoveredReceipt,
    )).toThrow();
    expect(readRecoveryCounts(recoveryWins)).toEqual({
      receipts: 1,
      recoveries: 1,
    });

    using liveWins = new Database(":memory:");
    installDispatchConsumptionRecoverySchema(liveWins);
    const live = prepareOperationFiveDispatchConsumption(liveWins);
    const liveReceipt = operationFiveDispatchConsumptionReceipt(
      liveWins,
      live,
    );
    insertOperationFiveDispatchConsumption(liveWins, liveReceipt);
    const lateRecovery = operationFiveDispatchConsumptionRecovery(
      liveWins,
      liveReceipt,
    );
    revokeOperationFive(liveWins, live);
    expect(() => liveWins.transaction(() => {
      insertOperationFiveDispatchConsumptionRecovery(
        liveWins,
        lateRecovery,
      );
      insertOperationFiveDispatchConsumption(liveWins, liveReceipt);
    })()).toThrow();
    expect(readRecoveryCounts(liveWins)).toEqual({
      receipts: 1,
      recoveries: 0,
    });
    expect(liveWins.query(`
      SELECT *
      FROM shard_placement_authority_operation_five_dispatch_consumptions
    `).get()).toMatchObject(liveReceipt);
  });

  test("rejects expired retention, source drift, and clock drift recovery", () => {
    for (const scenario of ["retention", "source", "clock"]) {
      using database = new Database(":memory:");
      installDispatchConsumptionRecoverySchema(database);
      const prepared = prepareOperationFiveDispatchConsumption(database);
      let receipt = operationFiveDispatchConsumptionReceipt(
        database,
        prepared,
      );
      const now = database.query(
        "SELECT unixepoch() AS now",
      ).get().now;
      if (scenario === "retention") {
        const claimedAt = now - 120;
        rewriteDispatchClaimClaimedAt(
          database,
          prepared.issuance.authorization_id_sha256,
          claimedAt,
        );
        prepared.dispatchClaim.claimed_at = claimedAt;
        receipt = {
          ...receipt,
          authority_dispatch_claimed_at: claimedAt,
          application_consumed_at: now - 100,
        };
      }
      let recovery = operationFiveDispatchConsumptionRecovery(
        database,
        receipt,
      );
      if (scenario === "retention") {
        recovery = {
          ...recovery,
          application_database_now: now - 2,
          retention_deadline_at: now - 1,
        };
      } else if (scenario === "source") {
        recovery = {
          ...recovery,
          application_database_identity_sha256: "f".repeat(64),
        };
      } else {
        recovery = {
          ...recovery,
          application_database_now: now + 120,
        };
      }
      revokeOperationFive(database, prepared);

      expect(() => database.transaction(() => {
        insertOperationFiveDispatchConsumptionRecovery(database, recovery);
        insertOperationFiveDispatchConsumption(database, receipt);
      })()).toThrow(
        "placement operation-five dispatch consumption recovery is not admissible",
      );
      expect(readRecoveryCounts(database)).toEqual({
        receipts: 0,
        recoveries: 0,
      });
    }
  });

  test("rolls back operation-5 admission when revocation wins", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    database.exec(executionMigrationSql);
    const issuance = validIssuance();
    insertIssuance(database, issuance);
    insertExecutionClaim(database, issuance);
    insertExecutionOperations(database, issuance.authorization_id_sha256);
    const claim = completeOperationFour(database, issuance);
    const admission = operationFiveAdmission(issuance);
    const start = operationFiveStart(issuance, claim, admission);
    database.query(`
      INSERT INTO shard_placement_authority_revocations (
        authorization_id_sha256, permit_subject_digest_sha256,
        reason_code, evidence_sha256, revocation_event_sha256,
        revoke_credential_id_sha256
      ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
    `).run(
      issuance.authorization_id_sha256,
      issuance.permit_subject_digest_sha256,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
    );

    expect(() => database.transaction(() => {
      insertOperationFiveAdmission(database, admission);
      insertExecutionReceipt(database, start);
    })()).toThrow(
      "placement operation-five admission is not authorized",
    );
    expect(database.query(`
      SELECT
        (SELECT COUNT(*)
         FROM shard_placement_authority_operation_five_admissions)
          AS admissions,
        (SELECT COUNT(*)
         FROM shard_placement_authority_execution_receipts
         WHERE operation_ordinal = 5) AS starts
    `).get()).toEqual({ admissions: 0, starts: 0 });
    expect(readExecutionClaim(database)).toMatchObject({
      status: "revoked",
      ledger_version: 3,
      enable_intent_seen: 0,
      disable_confirmed: 1,
    });
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
    receipt.receiptCredentialIdSha256 ?? "9".repeat(64),
    receipt.requestIdSha256 ?? "0".repeat(64),
    receipt.receiptDigestSha256,
  );
}

function completeOperationFour(database, issuance) {
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
    leaseGeneration: 1,
    leaseExpiresAt: claimed.lease_expires_at,
    receiptDigestSha256: "e".repeat(64),
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
    leaseGeneration: 1,
    leaseExpiresAt: claimed.lease_expires_at,
    receiptDigestSha256: "1".repeat(64),
  });
  return readExecutionClaim(database);
}

function operationFiveAdmission(issuance) {
  return {
    authorization_id_sha256: issuance.authorization_id_sha256,
    contract_version: 1,
    confirmation_contract:
      "cinatoken-shard-placement-authority-operation-five-admission-v1",
    claim_digest_sha256: "8".repeat(64),
    application_ticket_id_sha256: "c".repeat(64),
    application_ticket_digest_sha256: "d".repeat(64),
    application_database_identity_sha256: "e".repeat(64),
    application_activation_digest_sha256: "d".repeat(64),
    authority_activation_terminal_receipt_sha256: "1".repeat(64),
    authority_ledger_head_sha256: "1".repeat(64),
    authority_database_identity_sha256: "f".repeat(64),
    authority_version_id: "authority-test-v1",
    application_acknowledgement_digest_sha256: "2".repeat(64),
    application_version_id: "application-test-v1",
    application_read_credential_id_sha256: "3".repeat(64),
    application_read_request_id_sha256: "4".repeat(64),
    application_response_sha256: "5".repeat(64),
    application_response_bytes: 1024,
    enable_credential_id_sha256: "6".repeat(64),
    enable_request_id_sha256: "7".repeat(64),
    command_enable_request_id_sha256: "8".repeat(64),
    enable_operation_request_sha256: "9".repeat(64),
    confirmation_digest_sha256: "a".repeat(64),
    operation_start_receipt_digest_sha256: "0".repeat(64),
  };
}

function insertOperationFiveAdmission(database, admission) {
  const columns = Object.keys(admission);
  database.query(`
    INSERT INTO shard_placement_authority_operation_five_admissions (
      ${columns.join(", ")}
    ) VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => admission[column]));
}

function operationFiveStart(issuance, claim, admission) {
  return {
    authorizationIdSha256: issuance.authorization_id_sha256,
    sequence: 4,
    eventKind: "operation_started",
    operationOrdinal: 5,
    operationIdSha256: "5".repeat(64),
    operationKind: "enable_controller_deployment",
    predecessorReceiptSha256: "1".repeat(64),
    requestSha256: admission.enable_operation_request_sha256,
    responseSha256: null,
    evidenceSha256: admission.confirmation_digest_sha256,
    outcome: "pending",
    leaseOwnerSha256: claim.lease_owner_sha256,
    leaseTokenSha256: claim.lease_token_sha256,
    leaseGeneration: 1,
    leaseExpiresAt: claim.lease_expires_at,
    receiptCredentialIdSha256:
      admission.enable_credential_id_sha256,
    requestIdSha256: admission.enable_request_id_sha256,
    receiptDigestSha256:
      admission.operation_start_receipt_digest_sha256,
  };
}

function operationFiveDispatchOutbox(database, issuance, admission) {
  return {
    authorization_id_sha256: issuance.authorization_id_sha256,
    dispatch_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-outbox-v1",
    claim_digest_sha256: admission.claim_digest_sha256,
    application_ticket_id_sha256:
      admission.application_ticket_id_sha256,
    application_ticket_digest_sha256:
      admission.application_ticket_digest_sha256,
    application_database_identity_sha256:
      admission.application_database_identity_sha256,
    application_activation_digest_sha256:
      admission.application_activation_digest_sha256,
    application_acknowledgement_digest_sha256:
      admission.application_acknowledgement_digest_sha256,
    operation_five_admission_digest_sha256:
      admission.confirmation_digest_sha256,
    operation_five_start_receipt_sha256:
      admission.operation_start_receipt_digest_sha256,
    authority_database_identity_sha256:
      admission.authority_database_identity_sha256,
    authority_version_id: admission.authority_version_id,
    authority_ledger_head_sha256:
      admission.operation_start_receipt_digest_sha256,
    application_version_id: "application-dispatch-test-v1",
    application_read_credential_id_sha256: "b".repeat(64),
    application_read_request_id_sha256: "c".repeat(64),
    application_response_sha256: "d".repeat(64),
    application_response_bytes: 2048,
    application_database_now: database.query(
      "SELECT unixepoch() AS now",
    ).get().now,
    dispatch_credential_id_sha256: "e".repeat(64),
    dispatch_request_id_sha256: "f".repeat(64),
    command_dispatch_request_id_sha256: "0".repeat(64),
    controller_service_name: issuance.controller_service_name,
    controller_enable_operation_id_sha256: "5".repeat(64),
    controller_baseline_version_id: "controller-baseline-test-v1",
    controller_enabled_version_id: issuance.controller_version_id,
    dispatch_request_sha256: "1".repeat(64),
    outbox_digest_sha256: "2".repeat(64),
  };
}

function insertOperationFiveDispatchOutbox(database, outbox) {
  database.query(
    executionRepositorySqlForTest.insertOperationFiveDispatchOutbox,
  ).run(
    outbox.authorization_id_sha256,
    outbox.dispatch_contract,
    outbox.claim_digest_sha256,
    outbox.application_ticket_id_sha256,
    outbox.application_ticket_digest_sha256,
    outbox.application_database_identity_sha256,
    outbox.application_activation_digest_sha256,
    outbox.application_acknowledgement_digest_sha256,
    outbox.operation_five_admission_digest_sha256,
    outbox.operation_five_start_receipt_sha256,
    outbox.authority_database_identity_sha256,
    outbox.authority_version_id,
    outbox.authority_ledger_head_sha256,
    outbox.application_version_id,
    outbox.application_read_credential_id_sha256,
    outbox.application_read_request_id_sha256,
    outbox.application_response_sha256,
    outbox.application_response_bytes,
    outbox.application_database_now,
    outbox.dispatch_credential_id_sha256,
    outbox.dispatch_request_id_sha256,
    outbox.command_dispatch_request_id_sha256,
    outbox.controller_service_name,
    outbox.controller_enable_operation_id_sha256,
    outbox.controller_baseline_version_id,
    outbox.controller_enabled_version_id,
    outbox.dispatch_request_sha256,
    outbox.outbox_digest_sha256,
  );
}

function operationFiveApplicationGrant(database, issuance, outbox) {
  const databaseNow = database.query(
    "SELECT unixepoch() AS now",
  ).get().now;
  return {
    authorization_id_sha256: issuance.authorization_id_sha256,
    receipt_contract:
      "cinatoken-shard-placement-authority-operation-five-application-grant-receipt-v1",
    claim_digest_sha256: outbox.claim_digest_sha256,
    application_ticket_id_sha256:
      outbox.application_ticket_id_sha256,
    application_ticket_digest_sha256:
      outbox.application_ticket_digest_sha256,
    application_database_identity_sha256:
      outbox.application_database_identity_sha256,
    application_activation_digest_sha256:
      outbox.application_activation_digest_sha256,
    application_acknowledgement_digest_sha256:
      outbox.application_acknowledgement_digest_sha256,
    operation_five_admission_digest_sha256:
      outbox.operation_five_admission_digest_sha256,
    operation_five_start_receipt_sha256:
      outbox.operation_five_start_receipt_sha256,
    authority_dispatch_outbox_digest_sha256:
      outbox.outbox_digest_sha256,
    application_grant_digest_sha256: "3".repeat(64),
    application_grant_credential_id_sha256: "4".repeat(64),
    application_grant_request_id_sha256: "5".repeat(64),
    application_version_id: "application-grant-test-v1",
    application_response_sha256: "6".repeat(64),
    application_response_bytes: 3072,
    application_database_now: databaseNow,
    application_granted_at: databaseNow,
    authority_database_identity_sha256:
      outbox.authority_database_identity_sha256,
    authority_ledger_identity_sha256: "2".repeat(64),
    authority_ledger_head_sha256:
      outbox.authority_ledger_head_sha256,
    authority_version_id: outbox.authority_version_id,
    grant_credential_id_sha256: "7".repeat(64),
    grant_request_id_sha256: "8".repeat(64),
    command_grant_request_id_sha256: "9".repeat(64),
    controller_service_name: outbox.controller_service_name,
    controller_enable_operation_id_sha256:
      outbox.controller_enable_operation_id_sha256,
    controller_baseline_version_id:
      outbox.controller_baseline_version_id,
    controller_enabled_version_id:
      outbox.controller_enabled_version_id,
    receipt_digest_sha256: "a".repeat(64),
  };
}

function insertOperationFiveApplicationGrant(database, grant) {
  database.query(
    executionRepositorySqlForTest.insertOperationFiveApplicationGrant,
  ).run(
    grant.authorization_id_sha256,
    grant.receipt_contract,
    grant.claim_digest_sha256,
    grant.application_ticket_id_sha256,
    grant.application_ticket_digest_sha256,
    grant.application_database_identity_sha256,
    grant.application_activation_digest_sha256,
    grant.application_acknowledgement_digest_sha256,
    grant.operation_five_admission_digest_sha256,
    grant.operation_five_start_receipt_sha256,
    grant.authority_dispatch_outbox_digest_sha256,
    grant.application_grant_digest_sha256,
    grant.application_grant_credential_id_sha256,
    grant.application_grant_request_id_sha256,
    grant.application_version_id,
    grant.application_response_sha256,
    grant.application_response_bytes,
    grant.application_database_now,
    grant.application_granted_at,
    grant.authority_database_identity_sha256,
    grant.authority_ledger_identity_sha256,
    grant.authority_ledger_head_sha256,
    grant.authority_version_id,
    grant.grant_credential_id_sha256,
    grant.grant_request_id_sha256,
    grant.command_grant_request_id_sha256,
    grant.controller_service_name,
    grant.controller_enable_operation_id_sha256,
    grant.controller_baseline_version_id,
    grant.controller_enabled_version_id,
    grant.receipt_digest_sha256,
  );
}

function prepareOperationFiveApplicationGrant(database, insertGrant = true) {
  const issuance = validIssuance();
  insertIssuance(database, issuance);
  insertExecutionClaim(database, issuance);
  insertExecutionOperations(database, issuance.authorization_id_sha256);
  const operationFourClaim = completeOperationFour(database, issuance);
  const admission = operationFiveAdmission(issuance);
  const start = operationFiveStart(issuance, operationFourClaim, admission);
  database.transaction(() => {
    insertOperationFiveAdmission(database, admission);
    insertExecutionReceipt(database, start);
  })();
  const outbox = operationFiveDispatchOutbox(database, issuance, admission);
  insertOperationFiveDispatchOutbox(database, outbox);
  const applicationGrant = operationFiveApplicationGrant(
    database,
    issuance,
    outbox,
  );
  if (insertGrant) {
    insertOperationFiveApplicationGrant(database, applicationGrant);
    Object.assign(applicationGrant, database.query(`
      SELECT recorded_at
      FROM shard_placement_authority_operation_five_application_grants
      WHERE authorization_id_sha256 = ?
    `).get(issuance.authorization_id_sha256));
  }
  return { issuance, admission, outbox, applicationGrant };
}

function operationFiveDispatchClaim(database, prepared) {
  const claim = readExecutionClaim(database);
  return {
    authorization_id_sha256: prepared.issuance.authorization_id_sha256,
    contract_version: 1,
    claim_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-claim-v1",
    claim_digest_sha256: prepared.applicationGrant.claim_digest_sha256,
    application_ticket_id_sha256:
      prepared.applicationGrant.application_ticket_id_sha256,
    application_database_identity_sha256:
      prepared.applicationGrant.application_database_identity_sha256,
    authority_dispatch_outbox_digest_sha256:
      prepared.applicationGrant.authority_dispatch_outbox_digest_sha256,
    application_grant_receipt_digest_sha256:
      prepared.applicationGrant.receipt_digest_sha256,
    application_grant_digest_sha256:
      prepared.applicationGrant.application_grant_digest_sha256,
    operation_five_start_receipt_sha256:
      prepared.applicationGrant.operation_five_start_receipt_sha256,
    authority_database_identity_sha256:
      prepared.applicationGrant.authority_database_identity_sha256,
    authority_ledger_identity_sha256:
      prepared.applicationGrant.authority_ledger_identity_sha256,
    authority_ledger_head_sha256:
      prepared.applicationGrant.authority_ledger_head_sha256,
    authority_version_id:
      prepared.applicationGrant.authority_version_id,
    application_version_id:
      prepared.applicationGrant.application_version_id,
    dispatch_owner_sha256: claim.claim_owner_sha256,
    lease_token_sha256: claim.lease_token_sha256,
    lease_generation: claim.lease_generation,
    lease_expires_at: claim.lease_expires_at,
    normal_deadline_at: claim.normal_deadline_at,
    permit_expires_at: claim.permit_expires_at,
    dispatch_claim_credential_id_sha256: "b".repeat(64),
    dispatch_claim_request_id_sha256: "c".repeat(64),
    command_dispatch_claim_request_id_sha256: "d".repeat(64),
    controller_service_name:
      prepared.applicationGrant.controller_service_name,
    controller_enable_operation_id_sha256:
      prepared.applicationGrant.controller_enable_operation_id_sha256,
    controller_baseline_version_id:
      prepared.applicationGrant.controller_baseline_version_id,
    controller_enabled_version_id:
      prepared.applicationGrant.controller_enabled_version_id,
    send_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    dispatch_claim_digest_sha256: "e".repeat(64),
    claim_state: "claimed",
  };
}

function insertOperationFiveDispatchClaim(database, dispatchClaim) {
  const columns = Object.keys(dispatchClaim);
  database.query(`
    INSERT INTO shard_placement_authority_operation_five_dispatch_claims (
      ${columns.join(", ")}
    ) VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => dispatchClaim[column]));
}

function prepareOperationFiveDispatchConsumption(
  database,
  insertDispatchClaim = true,
) {
  const prepared = prepareOperationFiveApplicationGrant(database);
  const dispatchClaim = operationFiveDispatchClaim(database, prepared);
  if (insertDispatchClaim) {
    insertOperationFiveDispatchClaim(database, dispatchClaim);
    Object.assign(dispatchClaim, database.query(`
      SELECT claimed_at
      FROM shard_placement_authority_operation_five_dispatch_claims
      WHERE authorization_id_sha256 = ?
    `).get(prepared.issuance.authorization_id_sha256));
  } else {
    dispatchClaim.claimed_at = database.query(
      "SELECT unixepoch() AS now",
    ).get().now;
  }
  return { ...prepared, dispatchClaim };
}

function operationFiveDispatchConsumptionReceipt(database, prepared) {
  const dispatchClaim = prepared.dispatchClaim;
  return {
    authorization_id_sha256: dispatchClaim.authorization_id_sha256,
    contract_version: 1,
    receipt_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-receipt-v1",
    claim_digest_sha256: dispatchClaim.claim_digest_sha256,
    application_ticket_id_sha256:
      dispatchClaim.application_ticket_id_sha256,
    campaign_id: prepared.issuance.campaign_id,
    application_database_identity_sha256:
      dispatchClaim.application_database_identity_sha256,
    application_version_id: dispatchClaim.application_version_id,
    application_grant_receipt_digest_sha256:
      dispatchClaim.application_grant_receipt_digest_sha256,
    application_grant_digest_sha256:
      dispatchClaim.application_grant_digest_sha256,
    authority_dispatch_outbox_digest_sha256:
      dispatchClaim.authority_dispatch_outbox_digest_sha256,
    operation_five_start_receipt_sha256:
      dispatchClaim.operation_five_start_receipt_sha256,
    authority_dispatch_claim_digest_sha256:
      dispatchClaim.dispatch_claim_digest_sha256,
    authority_database_identity_sha256:
      dispatchClaim.authority_database_identity_sha256,
    authority_ledger_identity_sha256:
      dispatchClaim.authority_ledger_identity_sha256,
    authority_ledger_head_sha256:
      dispatchClaim.authority_ledger_head_sha256,
    authority_version_id: dispatchClaim.authority_version_id,
    dispatch_owner_sha256: dispatchClaim.dispatch_owner_sha256,
    lease_token_sha256: dispatchClaim.lease_token_sha256,
    lease_generation: dispatchClaim.lease_generation,
    lease_expires_at: dispatchClaim.lease_expires_at,
    normal_deadline_at: dispatchClaim.normal_deadline_at,
    permit_expires_at: dispatchClaim.permit_expires_at,
    dispatch_claim_credential_id_sha256:
      dispatchClaim.dispatch_claim_credential_id_sha256,
    dispatch_claim_request_id_sha256:
      dispatchClaim.dispatch_claim_request_id_sha256,
    command_dispatch_claim_request_id_sha256:
      dispatchClaim.command_dispatch_claim_request_id_sha256,
    authority_dispatch_claimed_at: dispatchClaim.claimed_at,
    controller_service_name: dispatchClaim.controller_service_name,
    controller_enable_operation_id_sha256:
      dispatchClaim.controller_enable_operation_id_sha256,
    controller_baseline_version_id:
      dispatchClaim.controller_baseline_version_id,
    controller_enabled_version_id:
      dispatchClaim.controller_enabled_version_id,
    send_attempt_limit: dispatchClaim.send_attempt_limit,
    retry_limit: dispatchClaim.retry_limit,
    missing_readback_allows_resend:
      dispatchClaim.missing_readback_allows_resend,
    application_dispatch_consumption_digest_sha256: "0".repeat(64),
    application_dispatch_consumption_credential_id_sha256:
      "1".repeat(64),
    application_dispatch_consumption_request_id_sha256: "2".repeat(64),
    command_dispatch_consumption_request_id_sha256: "3".repeat(64),
    application_consumption_state: "consumed",
    application_consumed_at: database.query(
      "SELECT unixepoch() AS now",
    ).get().now,
    application_response_sha256: "4".repeat(64),
    application_response_bytes: 4096,
    consume_credential_id_sha256: "5".repeat(64),
    consume_request_id_sha256: "6".repeat(64),
    command_consume_request_id_sha256: "7".repeat(64),
    receipt_digest_sha256: "8".repeat(64),
  };
}

function insertOperationFiveDispatchConsumption(database, receipt) {
  const columns = Object.keys(receipt);
  database.query(`
    INSERT INTO shard_placement_authority_operation_five_dispatch_consumptions (
      ${columns.join(", ")}
    ) VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => receipt[column]));
}

function installDispatchConsumptionRecoverySchema(database) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(migrationSql);
  database.exec(executionMigrationSql);
  database.exec(dispatchConsumptionMigrationSql);
  database.exec(dispatchConsumptionRecoveryMigrationSql);
}

function operationFiveDispatchConsumptionRecovery(
  database,
  receipt,
) {
  return {
    authorization_id_sha256: receipt.authorization_id_sha256,
    contract_version: 1,
    recovery_contract:
      "cinatoken-shard-placement-authority-operation-five-dispatch-consumption-recovery-v1",
    claim_digest_sha256: receipt.claim_digest_sha256,
    application_ticket_id_sha256:
      receipt.application_ticket_id_sha256,
    campaign_id: receipt.campaign_id,
    application_database_identity_sha256:
      receipt.application_database_identity_sha256,
    application_version_id: receipt.application_version_id,
    authority_dispatch_claim_digest_sha256:
      receipt.authority_dispatch_claim_digest_sha256,
    application_dispatch_consumption_digest_sha256:
      receipt.application_dispatch_consumption_digest_sha256,
    application_dispatch_consumption_credential_id_sha256:
      receipt.application_dispatch_consumption_credential_id_sha256,
    application_dispatch_consumption_request_id_sha256:
      receipt.application_dispatch_consumption_request_id_sha256,
    command_dispatch_consumption_request_id_sha256:
      receipt.command_dispatch_consumption_request_id_sha256,
    application_consumed_at: receipt.application_consumed_at,
    application_history_read_credential_id_sha256: "9".repeat(64),
    application_history_read_request_id_sha256: "a".repeat(64),
    application_response_sha256: receipt.application_response_sha256,
    application_response_bytes: receipt.application_response_bytes,
    application_database_now: database.query(
      "SELECT unixepoch() AS now",
    ).get().now,
    recovery_credential_id_sha256: receipt.consume_credential_id_sha256,
    recovery_request_id_sha256: receipt.consume_request_id_sha256,
    command_recovery_request_id_sha256:
      receipt.command_consume_request_id_sha256,
    retention_deadline_at:
      receipt.application_consumed_at + 2_592_000,
    receipt_digest_sha256: receipt.receipt_digest_sha256,
    recovery_evidence_digest_sha256: "b".repeat(64),
  };
}

function insertOperationFiveDispatchConsumptionRecovery(
  database,
  recovery,
) {
  const columns = Object.keys(recovery);
  database.query(`
    INSERT INTO
      shard_placement_authority_operation_five_dispatch_consumption_recoveries (
        ${columns.join(", ")}
      ) VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => recovery[column]));
}

function revokeOperationFive(database, prepared) {
  database.query(`
    INSERT INTO shard_placement_authority_revocations (
      authorization_id_sha256, permit_subject_digest_sha256,
      reason_code, evidence_sha256, revocation_event_sha256,
      revoke_credential_id_sha256
    ) VALUES (?, ?, 'operator_abort', ?, ?, ?)
  `).run(
    prepared.issuance.authorization_id_sha256,
    prepared.issuance.permit_subject_digest_sha256,
    "9".repeat(64),
    "a".repeat(64),
    "b".repeat(64),
  );
}

function readRecoveryCounts(database) {
  return database.query(`
    SELECT
      (SELECT COUNT(*)
       FROM shard_placement_authority_operation_five_dispatch_consumptions)
        AS receipts,
      (SELECT COUNT(*)
       FROM
         shard_placement_authority_operation_five_dispatch_consumption_recoveries)
        AS recoveries
  `).get();
}

function rewriteDispatchClaimClaimedAt(
  database,
  authorizationIdSha256,
  claimedAt,
) {
  const triggerName =
    "shard_placement_authority_operation_five_dispatch_claim_update_guard";
  const trigger = database.query(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND name = ?
  `).get(triggerName);
  if (trigger === null) {
    throw new Error("dispatch claim update guard is missing");
  }
  database.exec(`DROP TRIGGER ${triggerName}`);
  try {
    database.query(`
      UPDATE shard_placement_authority_operation_five_dispatch_claims
      SET claimed_at = ?
      WHERE authorization_id_sha256 = ?
    `).run(claimedAt, authorizationIdSha256);
  } finally {
    database.exec(trigger.sql);
  }
}

function assertRecoveryTriggerDigests(database) {
  const actual = Object.fromEntries(
    Object.keys(RECOVERY_TRIGGER_DIGESTS).map((name) => {
      const row = database.query(`
        SELECT sql
        FROM sqlite_schema
        WHERE type = 'trigger' AND name = ?
      `).get(name);
      const digest = row === null
        ? null
        : createHash("sha256")
          .update(row.sql.replace(/\s+/g, " ").trim().toLowerCase())
          .digest("hex");
      return [name, digest];
    }),
  );
  if (
    JSON.stringify(actual)
      !== JSON.stringify(RECOVERY_TRIGGER_DIGESTS)
  ) {
    throw new Error("Authority recovery trigger digest mismatch");
  }
}

function expectSqliteGuard(database, sql, value, message) {
  const statement = database.prepare(sql);
  try {
    expect(() => statement.run(value)).toThrow(message);
  } finally {
    statement.finalize();
  }
}

function readExecutionClaim(database) {
  return database.query(`
    SELECT *
    FROM shard_placement_authority_execution_claims
    LIMIT 1
  `).get();
}

function installAllAuthorityMigrations(database) {
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = join(
    import.meta.dir,
    "..",
    "services",
    "shard-placement-authority",
    "migrations",
  );
  for (const name of readdirSync(migrationsDirectory)
    .filter((candidate) => candidate.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(join(
      migrationsDirectory,
      name,
    ), "utf8"));
  }
}

function tableColumns(database, table) {
  return database.query(`
    SELECT name
    FROM pragma_table_info(?)
    ORDER BY cid
  `).all(table).map((row) => row.name);
}

function triggerSql(database, name) {
  const row = database.query(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = 'trigger' AND name = ?
  `).get(name);
  if (row === null) {
    throw new Error(`missing trigger: ${name}`);
  }
  return row.sql;
}

function forceOperationFourteenClaim(
  database,
  authorizationIdSha256,
) {
  const triggerNames = [
    "shard_placement_authority_execution_claim_identity_update_guard",
    "shard_placement_authority_execution_claim_projection_update_guard",
  ];
  const guards = triggerNames.map((name) => triggerSql(database, name));
  for (const name of triggerNames) {
    database.exec(`DROP TRIGGER ${name}`);
  }
  try {
    database.query(`
      UPDATE shard_placement_authority_execution_claims
      SET status = 'disable_required',
          ledger_version = 5,
          ledger_head_sha256 = ?,
          last_completed_ordinal = 5,
          inflight_operation_ordinal = NULL,
          inflight_operation_id_sha256 = NULL,
          inflight_request_sha256 = NULL,
          inflight_cloudflare_request_id_sha256 = NULL,
          inflight_started_generation = NULL,
          inflight_started_owner_sha256 = NULL,
          inflight_started_lease_token_sha256 = NULL,
          inflight_readback_only = 0,
          enable_intent_seen = 1,
          disable_confirmed = 0,
          ticket_activation_confirmed = 1,
          application_activation_digest_sha256 = ?,
          lease_expires_at = unixepoch() + 300,
          permit_expires_at = unixepoch() + 300,
          normal_deadline_at = unixepoch() + 300,
          recovery_deadline_at = unixepoch() + 900,
          updated_at = unixepoch()
      WHERE authorization_id_sha256 = ?
    `).run(
      "c".repeat(64),
      "d".repeat(64),
      authorizationIdSha256,
    );
  } finally {
    for (const guard of guards) {
      database.exec(guard);
    }
  }
}

function operationFourteenSqliteFixture(database, issuance) {
  database.exec("PRAGMA foreign_keys = OFF");
  const claim = readExecutionClaim(database);
  const attempt = {
    authorization_id_sha256: issuance.authorization_id_sha256,
    operation_ordinal: 14,
    contract_version: 1,
    attempt_contract:
      "cinatoken-shard-placement-authority-operation-fourteen-attempt-v1",
    claim_digest_sha256: claim.claim_digest_sha256,
    claim_owner_sha256: claim.claim_owner_sha256,
    lease_owner_sha256: claim.lease_owner_sha256,
    lease_token_sha256: claim.lease_token_sha256,
    lease_generation: claim.lease_generation,
    execution_plan_sha256: claim.execution_plan_sha256,
    operation_schedule_sha256: claim.operation_schedule_sha256,
    authority_database_identity_sha256:
      claim.authority_database_identity_sha256,
    authority_ledger_identity_sha256: claim.ledger_identity_sha256,
    ledger_version_before: claim.ledger_version,
    ledger_head_before_sha256: claim.ledger_head_sha256,
    operation_start_sequence: claim.ledger_version + 1,
    operation_five_terminal_receipt_sha256: "a".repeat(64),
    operation_five_send_attempt_digest_sha256: "b".repeat(64),
    operation_id_sha256: "e".repeat(64),
    operation_request_sha256: "0".repeat(64),
    controller_service_name: issuance.controller_service_name,
    controller_enabled_source_version_id:
      issuance.controller_version_id,
    controller_baseline_target_version_id:
      "controller-baseline-test-v1",
    authority_command_contract:
      "cinatoken-shard-placement-authority-disable-command-v1",
    authority_command_digest_sha256: "1".repeat(64),
    gateway_command_contract:
      "cinatoken-controller-deployment-gateway-disable-command-v1",
    gateway_command_digest_sha256: "2".repeat(64),
    gateway_idempotency_contract:
      "cinatoken-controller-deployment-gateway-disable-idempotency-v1",
    gateway_idempotency_key_sha256: "3".repeat(64),
    gateway_create_credential_id_sha256: "4".repeat(64),
    gateway_create_request_id_sha256: "5".repeat(64),
    gateway_status_credential_id_sha256: "6".repeat(64),
    gateway_status_request_id_sha256: "7".repeat(64),
    authority_version_id: "authority-test-v1",
    expected_gateway_version_id: "gateway-test-v1",
    disable_deadline_at: database.query(`
      SELECT unixepoch() + 120 AS deadline
    `).get().deadline,
    mutation_attempt_limit: 1,
    retry_limit: 0,
    missing_readback_allows_resend: 0,
    attempt_digest_sha256: "8".repeat(64),
    operation_start_receipt_digest_sha256: "9".repeat(64),
    disable_dispatched_event_digest_sha256: "d".repeat(64),
  };
  const dispatched = {
    authorization_id_sha256: attempt.authorization_id_sha256,
    attempt_digest_sha256: attempt.attempt_digest_sha256,
    event_sequence: 1,
    contract_version: 1,
    event_contract:
      "cinatoken-shard-placement-authority-operation-fourteen-gateway-event-v1",
    event_kind: "disable_dispatched",
    dispatch_semantics:
      "authority_persisted_network_may_not_have_occurred",
    credential_role: "disable_create",
    credential_id_sha256:
      attempt.gateway_create_credential_id_sha256,
    request_id_sha256: attempt.gateway_create_request_id_sha256,
    authority_command_digest_sha256:
      attempt.authority_command_digest_sha256,
    gateway_command_digest_sha256:
      attempt.gateway_command_digest_sha256,
    gateway_idempotency_key_sha256:
      attempt.gateway_idempotency_key_sha256,
    controller_service_name: attempt.controller_service_name,
    controller_baseline_target_version_id:
      attempt.controller_baseline_target_version_id,
    expected_gateway_version_id:
      attempt.expected_gateway_version_id,
    observed_gateway_version_id: null,
    observed_controller_version_id: null,
    status_classification: null,
    gateway_http_status: null,
    gateway_response_sha256: null,
    gateway_response_bytes: null,
    cloudflare_request_id_sha256: null,
    deployment_set_sha256: null,
    observation_digest_sha256: null,
    stability_minimum_seconds: null,
    predecessor_event_digest_sha256:
      attempt.attempt_digest_sha256,
    event_digest_sha256: "d".repeat(64),
  };

  const sourceGuardName =
    "shard_placement_authority_operation_fourteen_attempt_insert_guard";
  const sourceGuard = triggerSql(database, sourceGuardName);
  database.exec(`DROP TRIGGER ${sourceGuardName}`);
  try {
    database.transaction(() => {
      insertObject(
        database,
        "shard_placement_authority_operation_fourteen_attempts",
        attempt,
      );
      insertExecutionReceipt(database, {
        authorizationIdSha256: attempt.authorization_id_sha256,
        sequence: attempt.operation_start_sequence,
        eventKind: "operation_started",
        operationOrdinal: 14,
        operationIdSha256: attempt.operation_id_sha256,
        operationKind: "disable_controller_deployment",
        predecessorReceiptSha256:
          attempt.ledger_head_before_sha256,
        requestSha256: attempt.operation_request_sha256,
        responseSha256: null,
        evidenceSha256: attempt.attempt_digest_sha256,
        outcome: "pending",
        leaseOwnerSha256: attempt.lease_owner_sha256,
        leaseTokenSha256: attempt.lease_token_sha256,
        leaseGeneration: attempt.lease_generation,
        leaseExpiresAt: claim.lease_expires_at,
        receiptCredentialIdSha256:
          attempt.gateway_create_credential_id_sha256,
        requestIdSha256: attempt.gateway_create_request_id_sha256,
        receiptDigestSha256:
          attempt.operation_start_receipt_digest_sha256,
      });
      insertObject(
        database,
        "shard_placement_authority_operation_fourteen_gateway_events",
        dispatched,
      );
    })();
  } finally {
    database.exec(sourceGuard);
  }
  return { attempt, dispatched, terminal: null };
}

function appendOperationFourteenRejectedEvent(database, fixture) {
  const rejected = {
    authorization_id_sha256:
      fixture.attempt.authorization_id_sha256,
    attempt_digest_sha256:
      fixture.attempt.attempt_digest_sha256,
    event_sequence: 2,
    contract_version: 1,
    event_contract:
      "cinatoken-shard-placement-authority-operation-fourteen-gateway-event-v1",
    event_kind: "mutation_rejected",
    dispatch_semantics:
      "authority_persisted_network_may_not_have_occurred",
    credential_role: "disable_create",
    credential_id_sha256:
      fixture.attempt.gateway_create_credential_id_sha256,
    request_id_sha256: "e".repeat(64),
    authority_command_digest_sha256:
      fixture.attempt.authority_command_digest_sha256,
    gateway_command_digest_sha256:
      fixture.attempt.gateway_command_digest_sha256,
    gateway_idempotency_key_sha256:
      fixture.attempt.gateway_idempotency_key_sha256,
    controller_service_name:
      fixture.attempt.controller_service_name,
    controller_baseline_target_version_id:
      fixture.attempt.controller_baseline_target_version_id,
    expected_gateway_version_id:
      fixture.attempt.expected_gateway_version_id,
    observed_gateway_version_id: null,
    observed_controller_version_id: null,
    status_classification: null,
    gateway_http_status: 409,
    gateway_response_sha256: "f".repeat(64),
    gateway_response_bytes: 128,
    cloudflare_request_id_sha256: null,
    deployment_set_sha256: null,
    observation_digest_sha256: null,
    stability_minimum_seconds: null,
    predecessor_event_digest_sha256:
      fixture.dispatched.event_digest_sha256,
    event_digest_sha256: "1".repeat(64),
  };
  insertObject(
    database,
    "shard_placement_authority_operation_fourteen_gateway_events",
    rejected,
  );
  fixture.rejected = rejected;
}

function completeOperationFourteenRejected(database, fixture) {
  const claim = readExecutionClaim(database);
  const terminal = {
    authorization_id_sha256:
      fixture.attempt.authorization_id_sha256,
    operation_ordinal: 14,
    contract_version: 1,
    terminal_contract:
      "cinatoken-shard-placement-authority-operation-fourteen-terminal-v1",
    claim_digest_sha256: fixture.attempt.claim_digest_sha256,
    claim_owner_sha256: fixture.attempt.claim_owner_sha256,
    attempt_lease_owner_sha256:
      fixture.attempt.lease_owner_sha256,
    attempt_lease_token_sha256:
      fixture.attempt.lease_token_sha256,
    attempt_lease_generation:
      fixture.attempt.lease_generation,
    lease_owner_sha256: fixture.attempt.lease_owner_sha256,
    lease_token_sha256: fixture.attempt.lease_token_sha256,
    lease_generation: fixture.attempt.lease_generation,
    execution_plan_sha256: fixture.attempt.execution_plan_sha256,
    operation_schedule_sha256:
      fixture.attempt.operation_schedule_sha256,
    authority_database_identity_sha256:
      fixture.attempt.authority_database_identity_sha256,
    authority_ledger_identity_sha256:
      fixture.attempt.authority_ledger_identity_sha256,
    attempt_digest_sha256: fixture.attempt.attempt_digest_sha256,
    operation_id_sha256: fixture.attempt.operation_id_sha256,
    operation_request_sha256:
      fixture.attempt.operation_request_sha256,
    operation_start_receipt_digest_sha256:
      fixture.attempt.operation_start_receipt_digest_sha256,
    controller_service_name:
      fixture.attempt.controller_service_name,
    controller_enabled_source_version_id:
      fixture.attempt.controller_enabled_source_version_id,
    controller_baseline_target_version_id:
      fixture.attempt.controller_baseline_target_version_id,
    authority_command_digest_sha256:
      fixture.attempt.authority_command_digest_sha256,
    gateway_command_digest_sha256:
      fixture.attempt.gateway_command_digest_sha256,
    gateway_idempotency_key_sha256:
      fixture.attempt.gateway_idempotency_key_sha256,
    terminal_event_sequence: fixture.rejected.event_sequence,
    terminal_event_digest_sha256:
      fixture.rejected.event_digest_sha256,
    terminal_event_kind: fixture.rejected.event_kind,
    terminal_event_response_sha256:
      fixture.rejected.gateway_response_sha256,
    terminal_event_request_id_sha256:
      fixture.rejected.request_id_sha256,
    terminal_event_cloudflare_request_id_sha256:
      fixture.rejected.cloudflare_request_id_sha256,
    terminal_event_observation_digest_sha256: null,
    terminal_event_deployment_set_sha256: null,
    result_outcome: "rejected",
    recovery_mode: "fresh",
    terminal_response_sha256: "2".repeat(64),
    terminal_evidence_sha256: "3".repeat(64),
    authority_terminal_version_id: "authority-test-v1",
    terminal_writer_credential_id_sha256: "4".repeat(64),
    terminal_writer_request_id_sha256: "6".repeat(64),
    ledger_version_before: claim.ledger_version,
    ledger_head_before_sha256: claim.ledger_head_sha256,
    generic_receipt_sequence: claim.ledger_version + 1,
    generic_terminal_receipt_digest_sha256: "7".repeat(64),
  };
  database.transaction(() => {
    insertObject(
      database,
      "shard_placement_authority_operation_fourteen_terminals",
      terminal,
    );
    insertExecutionReceipt(database, {
      authorizationIdSha256: terminal.authorization_id_sha256,
      sequence: terminal.generic_receipt_sequence,
      eventKind: "operation_terminal",
      operationOrdinal: 14,
      operationIdSha256: terminal.operation_id_sha256,
      operationKind: "disable_controller_deployment",
      predecessorReceiptSha256:
        terminal.ledger_head_before_sha256,
      requestSha256: terminal.operation_request_sha256,
      responseSha256: terminal.terminal_response_sha256,
      evidenceSha256: terminal.terminal_evidence_sha256,
      outcome: terminal.result_outcome,
      leaseOwnerSha256: terminal.lease_owner_sha256,
      leaseTokenSha256: terminal.lease_token_sha256,
      leaseGeneration: terminal.lease_generation,
      leaseExpiresAt: claim.lease_expires_at,
      receiptCredentialIdSha256:
        terminal.terminal_writer_credential_id_sha256,
      requestIdSha256:
        terminal.terminal_writer_request_id_sha256,
      receiptDigestSha256:
        terminal.generic_terminal_receipt_digest_sha256,
    });
  })();
  fixture.terminal = terminal;
}

function insertObject(database, table, row) {
  const columns = Object.keys(row);
  database.query(`
    INSERT INTO ${table} (
      ${columns.join(", ")}
    ) VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => row[column]));
}
