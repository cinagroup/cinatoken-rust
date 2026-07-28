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
