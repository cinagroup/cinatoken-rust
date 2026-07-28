import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

const migrationNames = [
  "0054_relay_container_shard_activations.sql",
  "0055_relay_container_shard_activation_campaigns.sql",
  "0061_relay_container_shard_placement_attestations.sql",
  "0062_relay_container_shard_placement_events.sql",
  "0063_relay_container_shard_placement_mutation_authorizations.sql",
];
const migrations = new Map();

beforeAll(async () => {
  for (const name of migrationNames) {
    migrations.set(
      name,
      await readFile(
        path.resolve(import.meta.dir, "../migrations/d1", name),
        "utf8",
      ),
    );
  }
});

describe("Relay Container shard placement mutation authorization", () => {
  test("installs an exact append-only staging authorization schema", () => {
    const db = migratedDatabase();
    expect(columns(db)).toEqual([
      "authorization_id_sha256",
      "execution_nonce_sha256",
      "campaign_nonce_sha256",
      "subject_digest_sha256",
      "contract_version",
      "authorization_contract",
      "issuer",
      "key_id",
      "signer_spki_sha256",
      "environment",
      "controller_service_name",
      "controller_version_id",
      "action_gate_inventory_sha256",
      "foundation_manifest_sha256",
      "runtime_build_id",
      "ring_generation",
      "shard_count",
      "campaign_lifetime_seconds",
      "permit_issued_at",
      "permit_expires_at",
      "campaign_id",
      "campaign_digest_sha256",
      "campaign_expires_at",
      "consumed_by_admin_id",
      "consumed_at",
    ]);
    expect(schemaObjects(db)).toEqual([
      "index:idx_relay_container_shard_placement_authorizations_candidate",
      "table:relay_container_shard_placement_mutation_authorizations",
      "trigger:relay_container_shard_activation_campaign_authorization_guard",
      "trigger:relay_container_shard_placement_authorization_delete_guard",
      "trigger:relay_container_shard_placement_authorization_insert_guard",
      "trigger:relay_container_shard_placement_authorization_update_guard",
    ]);
    db.close();
  });

  test("atomically consumes one authorization before creating its exact campaign", () => {
    const db = migratedDatabase();
    createAuthorizedCampaign(db);
    expect(
      db
        .query(
          `SELECT authorization_id_sha256, environment, campaign_id,
                  campaign_nonce_sha256, consumed_by_admin_id
           FROM relay_container_shard_placement_mutation_authorizations`,
        )
        .get(),
    ).toEqual({
      authorization_id_sha256: "a".repeat(64),
      environment: "staging",
      campaign_id: "b".repeat(64),
      campaign_nonce_sha256: "c".repeat(64),
      consumed_by_admin_id: 42,
    });
    expect(
      db
        .query(
          "SELECT campaign_id, environment FROM relay_container_shard_activation_campaigns",
        )
        .get(),
    ).toEqual({ campaign_id: "b".repeat(64), environment: "staging" });
    db.close();
  });

  test("rejects missing, mismatched, production, replayed, and mutable authorization", () => {
    const missing = migratedDatabase();
    expect(() => insertCampaign(missing)).toThrow(
      "shard activation campaign authorization mismatch",
    );
    expect(
      missing
        .query(
          "SELECT COUNT(*) AS count FROM relay_container_shard_activation_campaigns",
        )
        .get(),
    ).toEqual({ count: 0 });
    missing.close();

    const mismatch = migratedDatabase();
    expect(() =>
      mismatch.transaction(() => {
        insertAuthorization(mismatch);
        insertCampaign(mismatch, { runtimeBuildId: "f".repeat(64) });
      })(),
    ).toThrow("shard activation campaign authorization mismatch");
    expect(
      mismatch
        .query(
          "SELECT COUNT(*) AS count FROM relay_container_shard_placement_mutation_authorizations",
        )
        .get(),
    ).toEqual({ count: 0 });
    mismatch.close();

    const production = migratedDatabase();
    expect(() =>
      insertAuthorization(production, { environment: "production" }),
    ).toThrow();
    production.close();

    const replay = migratedDatabase();
    createAuthorizedCampaign(replay);
    expect(() => insertAuthorization(replay)).toThrow();
    expect(() =>
      replay
        .query(
          `UPDATE relay_container_shard_placement_mutation_authorizations
           SET issuer = 'different'`,
        )
        .run(),
    ).toThrow("shard placement authorizations are immutable");
    expect(() =>
      replay
        .query(
          "DELETE FROM relay_container_shard_placement_mutation_authorizations",
        )
        .run(),
    ).toThrow("shard placement authorizations are append-preserved");
    replay.close();
  });

  test("makes the placement insert guard depend on the consumed authorization", () => {
    const sql = migrations.get(
      "0063_relay_container_shard_placement_mutation_authorizations.sql",
    );
    expect(sql).toContain(
      "FROM relay_container_shard_placement_mutation_authorizations AS authorization",
    );
    expect(sql).toContain(
      "shard placement mutation authorization is unavailable",
    );
    expect(sql).toContain(
      "relay_container_shard_activation_campaign_authorization_guard",
    );
  });
});

function migratedDatabase() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
  for (const name of migrationNames) {
    db.exec(migrations.get(name));
    db.query("INSERT INTO d1_migrations(name) VALUES (?)").run(name);
  }
  return db;
}

function createAuthorizedCampaign(db) {
  db.transaction(() => {
    insertAuthorization(db);
    insertCampaign(db);
  })();
}

function insertAuthorization(
  db,
  {
    environment = "staging",
    runtimeBuildId = "1".repeat(64),
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO relay_container_shard_placement_mutation_authorizations (
       authorization_id_sha256, execution_nonce_sha256,
       campaign_nonce_sha256, subject_digest_sha256, contract_version,
       authorization_contract, issuer, key_id, signer_spki_sha256,
       environment, controller_service_name, controller_version_id,
       action_gate_inventory_sha256, foundation_manifest_sha256,
       runtime_build_id, ring_generation, shard_count,
       campaign_lifetime_seconds, permit_issued_at, permit_expires_at,
       campaign_id, campaign_digest_sha256, campaign_expires_at,
       consumed_by_admin_id
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 7, 32,
               600, ?, ?, ?, ?, ?, 42)`,
  ).run(
    "a".repeat(64),
    "d".repeat(64),
    "c".repeat(64),
    "e".repeat(64),
    "cinatoken-relay-shard-placement-mutation-authorization-v1",
    "placement-authority-staging",
    "placement-v1",
    "f".repeat(64),
    environment,
    "cinatoken-container-controller-staging",
    "controller-version-001",
    "2".repeat(64),
    "3".repeat(64),
    runtimeBuildId,
    now,
    now + 300,
    "b".repeat(64),
    "4".repeat(64),
    now + 600,
  );
}

function insertCampaign(
  db,
  { runtimeBuildId = "1".repeat(64) } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO relay_container_shard_activation_campaigns (
       campaign_id, campaign_nonce_sha256, controller_version_id,
       action_gate_inventory_sha256, action_gate_count,
       all_action_gates_false, foundation_manifest_sha256,
       runtime_build_id, ring_generation, shard_count,
       shard_contract_version, runtime_protocol_version,
       runtime_contract_version, activation_generation, environment,
       created_by_admin_id, campaign_digest_sha256, created_at, expires_at
     ) VALUES (?, ?, ?, ?, 22, 1, ?, ?, 7, 32, 1, 1, 1, 1,
               'staging', 42, ?, ?, ?)`,
  ).run(
    "b".repeat(64),
    "c".repeat(64),
    "controller-version-001",
    "2".repeat(64),
    "3".repeat(64),
    runtimeBuildId,
    "4".repeat(64),
    now,
    now + 600,
  );
}

function columns(db) {
  return db
    .query(
      `SELECT name
       FROM pragma_table_info(
         'relay_container_shard_placement_mutation_authorizations'
       )
       ORDER BY cid`,
    )
    .all()
    .map(({ name }) => name);
}

function schemaObjects(db) {
  return db
    .query(
      `SELECT type || ':' || name AS object
       FROM sqlite_master
       WHERE name IN (
         'relay_container_shard_placement_mutation_authorizations',
         'idx_relay_container_shard_placement_authorizations_candidate',
         'relay_container_shard_activation_campaign_authorization_guard',
         'relay_container_shard_placement_authorization_insert_guard',
         'relay_container_shard_placement_authorization_update_guard',
         'relay_container_shard_placement_authorization_delete_guard'
       )
       ORDER BY object`,
    )
    .all()
    .map(({ object }) => object);
}
