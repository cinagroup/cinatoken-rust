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
  "0064_relay_container_shard_placement_execution_tickets.sql",
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

describe("Relay Container shard placement execution ticket", () => {
  test("installs three append-only handshake tables and additive guards", () => {
    const db = migratedDatabase();
    expect(columns(db, "relay_container_shard_placement_execution_tickets"))
      .toEqual([
        "ticket_id_sha256",
        "contract_version",
        "ticket_contract",
        "authorization_id_sha256",
        "campaign_id",
        "campaign_digest_sha256",
        "execution_nonce_sha256",
        "permit_subject_digest_sha256",
        "application_database_identity_sha256",
        "authority_database_identity_sha256",
        "authority_ledger_identity_sha256",
        "execution_plan_sha256",
        "operation_schedule_sha256",
        "preparation_operation_id_sha256",
        "claim_operation_id_sha256",
        "activation_operation_id_sha256",
        "controller_enable_operation_id_sha256",
        "controller_disable_operation_id_sha256",
        "release_sha256",
        "publication_sha256",
        "execution_activation_sha256",
        "runner_build_sha256",
        "controller_service_name",
        "controller_baseline_version_id",
        "controller_enabled_version_id",
        "controller_disabled_version_id",
        "edge_baseline_version_id",
        "action_gate_inventory_sha256",
        "action_gate_count",
        "all_action_gates_false",
        "foundation_manifest_sha256",
        "runtime_build_id",
        "ring_generation",
        "shard_count",
        "environment",
        "prepared_by_admin_id",
        "activation_deadline_at",
        "execution_deadline_at",
        "ticket_digest_sha256",
        "prepared_at",
      ]);
    expect(
      columns(
        db,
        "relay_container_shard_placement_execution_ticket_activations",
      ),
    ).toEqual([
      "ticket_id_sha256",
      "contract_version",
      "activation_contract",
      "authority_claim_digest_sha256",
      "authority_claim_acquired_receipt_sha256",
      "authority_claim_operation_id_sha256",
      "authority_activation_operation_id_sha256",
      "authority_database_identity_sha256",
      "authority_ledger_identity_sha256",
      "authority_version_id",
      "activation_credential_id_sha256",
      "activation_request_id_sha256",
      "activation_digest_sha256",
      "activated_by_admin_id",
      "activated_at",
    ]);
    expect(
      columns(
        db,
        "relay_container_shard_placement_execution_ticket_authority_acks",
      ),
    ).toEqual([
      "ticket_id_sha256",
      "contract_version",
      "acknowledgement_contract",
      "application_ticket_digest_sha256",
      "authority_claim_digest_sha256",
      "application_activation_digest_sha256",
      "authority_activation_terminal_receipt_sha256",
      "authority_ledger_head_sha256",
      "authority_database_identity_sha256",
      "authority_version_id",
      "authority_read_credential_id_sha256",
      "authority_read_request_id_sha256",
      "acknowledgement_digest_sha256",
      "acknowledged_by_admin_id",
      "acknowledged_at",
    ]);
    const triggers = db
      .query(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name IN (
             'relay_container_shard_activation_campaign_claim_insert_guard',
             'relay_container_shard_activation_campaign_claim_execution_ticket_guard'
           )
         ORDER BY name`,
      )
      .all()
      .map(({ name }) => name);
    expect(triggers).toEqual([
      "relay_container_shard_activation_campaign_claim_execution_ticket_guard",
      "relay_container_shard_activation_campaign_claim_insert_guard",
    ]);
    db.close();
  });

  test("prepares authorization, ticket, and campaign in one transaction", () => {
    const db = migratedDatabase();
    prepareCampaign(db);
    expect(
      db
        .query(
          `SELECT ticket_id_sha256, authorization_id_sha256, campaign_id,
                  prepared_by_admin_id
           FROM relay_container_shard_placement_execution_tickets`,
        )
        .get(),
    ).toEqual({
      ticket_id_sha256: hex("1"),
      authorization_id_sha256: hex("2"),
      campaign_id: hex("3"),
      prepared_by_admin_id: 42,
    });
    expect(
      db
        .query(
          "SELECT COUNT(*) AS count FROM relay_container_shard_activation_campaigns",
        )
        .get(),
    ).toEqual({ count: 1 });
    db.close();
  });

  test("rejects a campaign without its ticket and rolls back the authorization", () => {
    const db = migratedDatabase();
    expect(() =>
      db.transaction(() => {
        insertAuthorization(db);
        insertCampaign(db);
      })(),
    ).toThrow("shard activation campaign execution ticket mismatch");
    expect(
      db
        .query(
          `SELECT
             (SELECT COUNT(*) FROM relay_container_shard_placement_mutation_authorizations)
               AS authorization_count,
             (SELECT COUNT(*) FROM relay_container_shard_activation_campaigns)
               AS campaign_count`,
        )
        .get(),
    ).toEqual({ authorization_count: 0, campaign_count: 0 });
    db.close();
  });

  test("blocks shard claims until activation and Authority acknowledgement exist", () => {
    const db = migratedDatabase();
    prepareCampaign(db);
    expect(() => insertClaim(db)).toThrow(
      "shard activation campaign claim is not Authority-acknowledged",
    );
    insertActivation(db);
    expect(() => insertClaim(db)).toThrow(
      "shard activation campaign claim is not Authority-acknowledged",
    );
    insertAuthorityAcknowledgement(db);
    insertClaim(db);
    expect(
      db
        .query(
          `SELECT campaign_id, shard_index
           FROM relay_container_shard_activation_campaign_claims`,
        )
        .get(),
    ).toEqual({ campaign_id: hex("3"), shard_index: 0 });
    db.close();
  });

  test("rejects mismatched activation and preserves both ledgers", () => {
    const db = migratedDatabase();
    prepareCampaign(db);
    expect(() =>
      insertActivation(db, {
        authorityDatabaseIdentitySha256: hex("e"),
      }),
    ).toThrow("shard placement execution ticket is not activatable");
    insertActivation(db);
    expect(() =>
      db
        .query(
          `UPDATE relay_container_shard_placement_execution_tickets
           SET controller_enabled_version_id = 'controller-other'`,
        )
        .run(),
    ).toThrow("shard placement execution tickets are immutable");
    expect(() =>
      db
        .query(
          "DELETE FROM relay_container_shard_placement_execution_ticket_activations",
        )
        .run(),
    ).toThrow(
      "shard placement execution ticket activations are append-preserved",
    );
    insertAuthorityAcknowledgement(db);
    expect(() =>
      db
        .query(
          "DELETE FROM relay_container_shard_placement_execution_ticket_authority_acks",
        )
        .run(),
    ).toThrow("shard placement Authority acknowledgements are append-preserved");
    db.close();
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

function prepareCampaign(db) {
  db.transaction(() => {
    insertAuthorization(db);
    insertTicket(db);
    insertCampaign(db);
  })();
}

function insertAuthorization(db) {
  const now = epoch();
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
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?,
               7, 8, 300, ?, ?, ?, ?, ?, 42)`,
  ).run(
    hex("2"),
    hex("4"),
    hex("5"),
    hex("6"),
    "cinatoken-relay-shard-placement-mutation-authorization-v1",
    "placement-authority-staging",
    "placement-v1",
    hex("7"),
    "cinatoken-container-controller-staging",
    "controller-enabled-v1",
    hex("8"),
    hex("9"),
    hex("a"),
    now,
    now + 300,
    hex("3"),
    hex("b"),
    now + 300,
  );
}

function insertTicket(db) {
  const now = epoch();
  db.query(
    `INSERT INTO relay_container_shard_placement_execution_tickets (
       ticket_id_sha256, contract_version, ticket_contract,
       authorization_id_sha256, campaign_id, campaign_digest_sha256,
       execution_nonce_sha256, permit_subject_digest_sha256,
       application_database_identity_sha256,
       authority_database_identity_sha256,
       authority_ledger_identity_sha256, execution_plan_sha256,
       operation_schedule_sha256, preparation_operation_id_sha256,
       claim_operation_id_sha256, activation_operation_id_sha256,
       controller_enable_operation_id_sha256,
       controller_disable_operation_id_sha256, release_sha256,
       publication_sha256, execution_activation_sha256, runner_build_sha256,
       controller_service_name, controller_baseline_version_id,
       controller_enabled_version_id, controller_disabled_version_id,
       edge_baseline_version_id, action_gate_inventory_sha256,
       action_gate_count, all_action_gates_false, foundation_manifest_sha256,
       runtime_build_id, ring_generation, shard_count, environment,
       prepared_by_admin_id, activation_deadline_at,
       execution_deadline_at, ticket_digest_sha256
     ) VALUES (
       ?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
       ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21,
       'cinatoken-container-controller-staging',
       ?22, ?23, ?24, ?25, ?26, 22, 1, ?27, ?28, 7, 8, 'staging', 42,
       ?29, ?30, ?31
     )`,
  ).run(
    hex("1"),
    "cinatoken-relay-container-shard-placement-execution-ticket-v1",
    hex("2"),
    hex("3"),
    hex("b"),
    hex("4"),
    hex("6"),
    hex("c"),
    hex("d"),
    hexPair("22"),
    hex("e"),
    hex("f"),
    hexPair("10"),
    hexPair("11"),
    hexPair("12"),
    hexPair("13"),
    hexPair("14"),
    hexPair("15"),
    hexPair("16"),
    hexPair("17"),
    hexPair("18"),
    "controller-disabled-v1",
    "controller-enabled-v1",
    "controller-disabled-v1",
    "edge-baseline-v1",
    hex("8"),
    hex("9"),
    hex("a"),
    now + 240,
    now + 300,
    hexPair("19"),
  );
}

function insertCampaign(db) {
  const now = epoch();
  db.query(
    `INSERT INTO relay_container_shard_activation_campaigns (
       campaign_id, campaign_nonce_sha256, controller_version_id,
       action_gate_inventory_sha256, action_gate_count,
       all_action_gates_false, foundation_manifest_sha256,
       runtime_build_id, ring_generation, shard_count,
       shard_contract_version, runtime_protocol_version,
       runtime_contract_version, activation_generation, environment,
       created_by_admin_id, campaign_digest_sha256, created_at, expires_at
     ) VALUES (?, ?, ?, ?, 22, 1, ?, ?, 7, 8, 1, 1, 1, 1,
               'staging', 42, ?, ?, ?)`,
  ).run(
    hex("3"),
    hex("5"),
    "controller-enabled-v1",
    hex("8"),
    hex("9"),
    hex("a"),
    hex("b"),
    now,
    now + 300,
  );
}

function insertActivation(
  db,
  { authorityDatabaseIdentitySha256 = hex("d") } = {},
) {
  db.query(
    `INSERT INTO relay_container_shard_placement_execution_ticket_activations (
       ticket_id_sha256, contract_version, activation_contract,
       authority_claim_digest_sha256,
       authority_claim_acquired_receipt_sha256,
       authority_claim_operation_id_sha256,
       authority_activation_operation_id_sha256,
       authority_database_identity_sha256,
       authority_ledger_identity_sha256, authority_version_id,
       activation_credential_id_sha256, activation_request_id_sha256,
       activation_digest_sha256, activated_by_admin_id
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 42)`,
  ).run(
    hex("1"),
    "cinatoken-relay-container-shard-placement-execution-ticket-activation-v1",
    hexPair("20"),
    hexPair("21"),
    hexPair("11"),
    hexPair("12"),
    authorityDatabaseIdentitySha256,
    hexPair("22"),
    "authority-version-v1",
    hexPair("23"),
    hexPair("24"),
    hexPair("25"),
  );
}

function insertAuthorityAcknowledgement(db) {
  db.query(
    `INSERT INTO relay_container_shard_placement_execution_ticket_authority_acks (
       ticket_id_sha256, contract_version, acknowledgement_contract,
       application_ticket_digest_sha256, authority_claim_digest_sha256,
       application_activation_digest_sha256,
       authority_activation_terminal_receipt_sha256,
       authority_ledger_head_sha256, authority_database_identity_sha256,
       authority_version_id, authority_read_credential_id_sha256,
       authority_read_request_id_sha256, acknowledgement_digest_sha256,
       acknowledged_by_admin_id
     ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 42)`,
  ).run(
    hex("1"),
    "cinatoken-relay-container-shard-placement-authority-ack-v1",
    hexPair("19"),
    hexPair("20"),
    hexPair("25"),
    hexPair("28"),
    hexPair("29"),
    hex("d"),
    "authority-version-v1",
    hexPair("2a"),
    hexPair("2b"),
    hexPair("2c"),
  );
}

function insertClaim(db) {
  db.query(
    `INSERT INTO relay_container_shard_activation_campaign_claims (
       campaign_id, shard_index, presented_nonce_sha256,
       campaign_digest_sha256, controller_version_id,
       action_gate_inventory_sha256, action_gate_count,
       all_action_gates_false, foundation_manifest_sha256,
       runtime_build_id, ring_generation, shard_count, instance_name,
       shard_contract_version, runtime_protocol_version,
       runtime_contract_version, activation_generation, probe_id,
       claim_digest_sha256, environment
     ) VALUES (?, 0, ?, ?, ?, ?, 22, 1, ?, ?, 7, 8, ?, 1, 1, 1, 1,
               ?, ?, 'staging')`,
  ).run(
    hex("3"),
    hex("5"),
    hex("b"),
    "controller-enabled-v1",
    hex("8"),
    hex("9"),
    hex("a"),
    "cinatoken-relay-shard-v1-0000",
    hexPair("26"),
    hexPair("27"),
  );
}

function columns(db, table) {
  return db
    .query(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all(table)
    .map(({ name }) => name);
}

function epoch() {
  return Math.floor(Date.now() / 1_000);
}

function hex(value) {
  return value.repeat(64);
}

function hexPair(value) {
  return value.padStart(2, "0").repeat(32);
}
