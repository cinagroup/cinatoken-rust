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
  "0065_relay_container_shard_placement_pre_enable_grants.sql",
  "0066_relay_container_shard_placement_dispatch_consumptions.sql",
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

  test("installs one append-only application pre-enable grant table", () => {
    const db = migratedDatabase();
    expect(
      columns(
        db,
        "relay_container_shard_placement_pre_enable_grants",
      ),
    ).toEqual([
      "ticket_id_sha256",
      "contract_version",
      "grant_contract",
      "authorization_id_sha256",
      "application_ticket_digest_sha256",
      "application_database_identity_sha256",
      "authority_claim_digest_sha256",
      "application_activation_digest_sha256",
      "application_acknowledgement_digest_sha256",
      "operation_five_admission_digest_sha256",
      "operation_five_start_receipt_sha256",
      "authority_dispatch_outbox_digest_sha256",
      "authority_database_identity_sha256",
      "authority_ledger_identity_sha256",
      "authority_ledger_head_sha256",
      "authority_version_id",
      "controller_service_name",
      "controller_enable_operation_id_sha256",
      "controller_baseline_version_id",
      "controller_enabled_version_id",
      "application_grant_credential_id_sha256",
      "application_grant_request_id_sha256",
      "grant_digest_sha256",
      "granted_at",
    ]);
    expect(
      db
        .query(
          `SELECT type, name
           FROM sqlite_master
           WHERE tbl_name =
             'relay_container_shard_placement_pre_enable_grants'
             AND name NOT LIKE 'sqlite_autoindex_%'
           ORDER BY type, name`,
        )
        .all(),
    ).toEqual([
      {
        type: "index",
        name: "idx_relay_container_shard_placement_pre_enable_grants_claim",
      },
      {
        type: "table",
        name: "relay_container_shard_placement_pre_enable_grants",
      },
      {
        type: "trigger",
        name: "relay_container_shard_placement_pre_enable_grant_delete_guard",
      },
      {
        type: "trigger",
        name: "relay_container_shard_placement_pre_enable_grant_insert_guard",
      },
      {
        type: "trigger",
        name: "relay_container_shard_placement_pre_enable_grant_update_guard",
      },
    ]);
    db.close();
  });

  test("creates exactly one immutable grant from the acknowledged ticket", () => {
    const db = migratedDatabase();
    prepareCampaign(db);
    insertActivation(db);
    insertAuthorityAcknowledgement(db);
    insertPreEnableGrant(db);
    expect(
      db
        .query(
          `SELECT ticket_id_sha256, authorization_id_sha256,
                  operation_five_start_receipt_sha256,
                  authority_ledger_head_sha256, controller_enabled_version_id
           FROM relay_container_shard_placement_pre_enable_grants`,
        )
        .get(),
    ).toEqual({
      ticket_id_sha256: hex("1"),
      authorization_id_sha256: hex("2"),
      operation_five_start_receipt_sha256: hexPair("2d"),
      authority_ledger_head_sha256: hexPair("2d"),
      controller_enabled_version_id: "controller-enabled-v1",
    });
    const replay = insertPreEnableGrant(db, { orIgnore: true });
    expect(replay.changes).toBe(0);
    expect(() =>
      db
        .query(
          `UPDATE relay_container_shard_placement_pre_enable_grants
           SET authority_version_id = 'authority-version-v2'`,
        )
        .run(),
    ).toThrow("shard placement pre-enable grants are immutable");
    expect(() =>
      db
        .query(
          "DELETE FROM relay_container_shard_placement_pre_enable_grants",
        )
        .run(),
    ).toThrow("shard placement pre-enable grants are append-preserved");
    db.close();
  });

  test("fails closed before acknowledgement, after seal, or on identity drift", () => {
    const beforeAck = migratedDatabase();
    prepareCampaign(beforeAck);
    insertActivation(beforeAck);
    expect(() => insertPreEnableGrant(beforeAck)).toThrow(
      "shard placement pre-enable grant is not admissible",
    );
    beforeAck.close();

    const sealed = migratedDatabase();
    prepareCampaign(sealed);
    insertActivation(sealed);
    insertAuthorityAcknowledgement(sealed);
    sealCampaign(sealed);
    expect(() => insertPreEnableGrant(sealed)).toThrow(
      "shard placement pre-enable grant is not admissible",
    );
    sealed.close();

    const drift = migratedDatabase();
    prepareCampaign(drift);
    insertActivation(drift);
    insertAuthorityAcknowledgement(drift);
    expect(() =>
      insertPreEnableGrant(drift, {
        authorityDatabaseIdentitySha256: hex("e"),
      }),
    ).toThrow("shard placement pre-enable grant is not admissible");
    expect(() =>
      insertPreEnableGrant(drift, {
        operationFiveStartReceiptSha256: hexPair("29"),
      }),
    ).toThrow(
      /CHECK constraint failed|shard placement pre-enable grant is not admissible/,
    );
    drift.close();
  });

  test("installs the application-owned dispatch consumption contract", () => {
    const db = migratedDatabase();
    expect(
      columns(
        db,
        "relay_container_shard_placement_dispatch_consumptions",
      ),
    ).toEqual([
      "ticket_id_sha256",
      "contract_version",
      "consumption_contract",
      "authorization_id_sha256",
      "campaign_id",
      "application_database_identity_sha256",
      "application_version_id",
      "application_grant_digest_sha256",
      "authority_claim_digest_sha256",
      "authority_dispatch_outbox_digest_sha256",
      "application_grant_receipt_digest_sha256",
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
      "application_dispatch_consumption_credential_id_sha256",
      "application_dispatch_consumption_request_id_sha256",
      "command_dispatch_consumption_request_id_sha256",
      "dispatch_consumption_digest_sha256",
      "consumption_state",
      "consumed_at",
    ]);
    expect(
      db
        .query(
          `SELECT type, name
           FROM sqlite_master
           WHERE tbl_name =
             'relay_container_shard_placement_dispatch_consumptions'
             AND name NOT LIKE 'sqlite_autoindex_%'
           ORDER BY type, name`,
        )
        .all(),
    ).toEqual([
      {
        type: "index",
        name: "idx_relay_container_shard_placement_dispatch_consumptions_claim",
      },
      {
        type: "table",
        name: "relay_container_shard_placement_dispatch_consumptions",
      },
      {
        type: "trigger",
        name: "relay_container_shard_placement_dispatch_consumption_delete_guard",
      },
      {
        type: "trigger",
        name: "relay_container_shard_placement_dispatch_consumption_insert_guard",
      },
      {
        type: "trigger",
        name: "relay_container_shard_placement_dispatch_consumption_update_guard",
      },
    ]);
    db.close();
  });

  test("creates one immutable application dispatch consumption", () => {
    const db = migratedDatabase();
    prepareDispatchConsumption(db);
    insertDispatchConsumption(db);
    expect(
      db
        .query(
          `SELECT ticket_id_sha256, authorization_id_sha256, campaign_id,
                  application_grant_digest_sha256,
                  authority_dispatch_claim_digest_sha256,
                  controller_enable_operation_id_sha256,
                  send_attempt_limit, retry_limit,
                  missing_readback_allows_resend, consumption_state
           FROM relay_container_shard_placement_dispatch_consumptions`,
        )
        .get(),
    ).toEqual({
      ticket_id_sha256: hex("1"),
      authorization_id_sha256: hex("2"),
      campaign_id: hex("3"),
      application_grant_digest_sha256: hexPair("32"),
      authority_dispatch_claim_digest_sha256: hexPair("34"),
      controller_enable_operation_id_sha256: hexPair("13"),
      send_attempt_limit: 1,
      retry_limit: 0,
      missing_readback_allows_resend: 0,
      consumption_state: "consumed",
    });
    expect(() =>
      db
        .query(
          `UPDATE relay_container_shard_placement_dispatch_consumptions
           SET authority_version_id = 'authority-version-v2'`,
        )
        .run(),
    ).toThrow("shard placement dispatch consumptions are immutable");
    expect(() =>
      db
        .query(
          "DELETE FROM relay_container_shard_placement_dispatch_consumptions",
        )
        .run(),
    ).toThrow("shard placement dispatch consumptions are append-preserved");
    db.close();
  });

  test("orders dispatch consumption against campaign seal", () => {
    const sealFirst = migratedDatabase();
    prepareDispatchConsumption(sealFirst);
    sealCampaign(sealFirst);
    expect(() => insertDispatchConsumption(sealFirst)).toThrow(
      "shard placement dispatch consumption is not admissible",
    );
    expect(
      sealFirst
        .query(
          "SELECT COUNT(*) AS count FROM relay_container_shard_placement_dispatch_consumptions",
        )
        .get(),
    ).toEqual({ count: 0 });
    sealFirst.close();

    const consumptionFirst = migratedDatabase();
    prepareDispatchConsumption(consumptionFirst);
    insertDispatchConsumption(consumptionFirst);
    sealCampaign(consumptionFirst);
    expect(
      consumptionFirst
        .query(
          `SELECT consumption.consumption_state,
                  seal.seal_reason, seal.seal_detail_code
           FROM relay_container_shard_placement_dispatch_consumptions
             AS consumption
           JOIN relay_container_shard_activation_campaign_seals AS seal
             ON seal.campaign_id = consumption.campaign_id`,
        )
        .get(),
    ).toEqual({
      consumption_state: "consumed",
      seal_reason: "aborted",
      seal_detail_code: "operator_aborted",
    });
    consumptionFirst.close();
  });

  test("rejects authority deadline equality at Application D1", () => {
    for (const field of [
      "leaseExpiresAt",
      "normalDeadlineAt",
      "permitExpiresAt",
    ]) {
      const db = migratedDatabase();
      prepareDispatchConsumption(db);
      const databaseNow = db.query("SELECT unixepoch() AS now").get().now;
      expect(() =>
        insertDispatchConsumption(db, { [field]: databaseNow }),
      ).toThrow(
        /CHECK constraint failed|shard placement dispatch consumption is not admissible/,
      );
      db.close();
    }
  });

  test("requires the application grant and rejects local evidence drift", () => {
    const missingGrant = migratedDatabase();
    prepareCampaign(missingGrant);
    insertActivation(missingGrant);
    insertAuthorityAcknowledgement(missingGrant);
    expect(() => insertDispatchConsumption(missingGrant)).toThrow(
      /FOREIGN KEY constraint failed|shard placement dispatch consumption is not admissible/,
    );
    missingGrant.close();

    for (const overrides of [
      { campaignId: hex("4") },
      { applicationDatabaseIdentitySha256: hex("e") },
      { applicationGrantDigestSha256: hexPair("40") },
      { authorityClaimDigestSha256: hexPair("41") },
      { authorityDispatchOutboxDigestSha256: hexPair("42") },
      { authorityDatabaseIdentitySha256: hex("f") },
      { authorityLedgerIdentitySha256: hexPair("43") },
      { controllerEnableOperationIdSha256: hexPair("44") },
      { controllerEnabledVersionId: "controller-enabled-v2" },
      { authorityDispatchClaimedAt: epoch() - 60 },
      { authorityDispatchClaimedAt: epoch() + 60 },
    ]) {
      const db = migratedDatabase();
      prepareDispatchConsumption(db);
      expect(() => insertDispatchConsumption(db, overrides)).toThrow(
        /FOREIGN KEY constraint failed|shard placement dispatch consumption is not admissible/,
      );
      db.close();
    }
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

function insertPreEnableGrant(
  db,
  {
    authorityDatabaseIdentitySha256 = hex("d"),
    operationFiveStartReceiptSha256 = hexPair("2d"),
    orIgnore = false,
  } = {},
) {
  return db
    .query(
      `INSERT ${orIgnore ? "OR IGNORE " : ""}
       INTO relay_container_shard_placement_pre_enable_grants (
         ticket_id_sha256, contract_version, grant_contract,
         authorization_id_sha256, application_ticket_digest_sha256,
         application_database_identity_sha256,
         authority_claim_digest_sha256,
         application_activation_digest_sha256,
         application_acknowledgement_digest_sha256,
         operation_five_admission_digest_sha256,
         operation_five_start_receipt_sha256,
         authority_dispatch_outbox_digest_sha256,
         authority_database_identity_sha256,
         authority_ledger_identity_sha256,
         authority_ledger_head_sha256, authority_version_id,
         controller_service_name, controller_enable_operation_id_sha256,
         controller_baseline_version_id, controller_enabled_version_id,
         application_grant_credential_id_sha256,
         application_grant_request_id_sha256, grant_digest_sha256
       ) VALUES (
         ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         'cinatoken-container-controller-staging', ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      hex("1"),
      "cinatoken-relay-container-shard-placement-pre-enable-grant-v1",
      hex("2"),
      hexPair("19"),
      hex("c"),
      hexPair("20"),
      hexPair("25"),
      hexPair("2c"),
      hexPair("2e"),
      operationFiveStartReceiptSha256,
      hexPair("2f"),
      authorityDatabaseIdentitySha256,
      hexPair("22"),
      operationFiveStartReceiptSha256,
      "authority-version-v1",
      hexPair("13"),
      "controller-disabled-v1",
      "controller-enabled-v1",
      hexPair("30"),
      hexPair("31"),
      hexPair("32"),
    );
}

function sealCampaign(db) {
  db.query(
    `INSERT INTO relay_container_shard_activation_campaign_seals (
       campaign_id, campaign_digest_sha256, consumed_shard_count,
       seal_reason, seal_detail_code, last_consumption_digest_sha256
     ) VALUES (?, ?, 0, 'aborted', 'operator_aborted', NULL)`,
  ).run(hex("3"), hex("b"));
}

function prepareDispatchConsumption(db) {
  prepareCampaign(db);
  insertActivation(db);
  insertAuthorityAcknowledgement(db);
  insertPreEnableGrant(db);
}

function insertDispatchConsumption(db, overrides = {}) {
  const context = db
    .query(
      `SELECT ticket.execution_deadline_at,
              authorization.permit_expires_at,
              unixepoch() AS database_now
       FROM relay_container_shard_placement_execution_tickets AS ticket
       JOIN relay_container_shard_placement_mutation_authorizations
         AS authorization
         ON authorization.authorization_id_sha256 =
              ticket.authorization_id_sha256
       WHERE ticket.ticket_id_sha256 = ?`,
    )
    .get(hex("1"));
  const values = {
    ticketIdSha256: hex("1"),
    authorizationIdSha256: hex("2"),
    campaignId: hex("3"),
    applicationDatabaseIdentitySha256: hex("c"),
    applicationVersionId: "application-version-v1",
    applicationGrantDigestSha256: hexPair("32"),
    authorityClaimDigestSha256: hexPair("20"),
    authorityDispatchOutboxDigestSha256: hexPair("2f"),
    applicationGrantReceiptDigestSha256: hexPair("33"),
    operationFiveStartReceiptSha256: hexPair("2d"),
    authorityDispatchClaimDigestSha256: hexPair("34"),
    authorityDatabaseIdentitySha256: hex("d"),
    authorityLedgerIdentitySha256: hexPair("22"),
    authorityLedgerHeadSha256: hexPair("2d"),
    authorityVersionId: "authority-version-v1",
    dispatchOwnerSha256: hexPair("35"),
    leaseTokenSha256: hexPair("36"),
    leaseGeneration: 1,
    leaseExpiresAt: context.database_now + 60,
    normalDeadlineAt: context.execution_deadline_at,
    permitExpiresAt: context.permit_expires_at,
    dispatchClaimCredentialIdSha256: hexPair("37"),
    dispatchClaimRequestIdSha256: hexPair("38"),
    commandDispatchClaimRequestIdSha256: hexPair("39"),
    authorityDispatchClaimedAt: context.database_now,
    controllerServiceName: "cinatoken-container-controller-staging",
    controllerEnableOperationIdSha256: hexPair("13"),
    controllerBaselineVersionId: "controller-disabled-v1",
    controllerEnabledVersionId: "controller-enabled-v1",
    sendAttemptLimit: 1,
    retryLimit: 0,
    missingReadbackAllowsResend: 0,
    applicationDispatchConsumptionCredentialIdSha256: hexPair("3a"),
    applicationDispatchConsumptionRequestIdSha256: hexPair("3b"),
    commandDispatchConsumptionRequestIdSha256: hexPair("3c"),
    dispatchConsumptionDigestSha256: hexPair("3d"),
    consumptionState: "consumed",
    ...overrides,
  };
  return db
    .query(
      `INSERT INTO relay_container_shard_placement_dispatch_consumptions (
         ticket_id_sha256, contract_version, consumption_contract,
         authorization_id_sha256, campaign_id,
         application_database_identity_sha256, application_version_id,
         application_grant_digest_sha256, authority_claim_digest_sha256,
         authority_dispatch_outbox_digest_sha256,
         application_grant_receipt_digest_sha256,
         operation_five_start_receipt_sha256,
         authority_dispatch_claim_digest_sha256,
         authority_database_identity_sha256,
         authority_ledger_identity_sha256, authority_ledger_head_sha256,
         authority_version_id, dispatch_owner_sha256, lease_token_sha256,
         lease_generation, lease_expires_at, normal_deadline_at,
         permit_expires_at, dispatch_claim_credential_id_sha256,
         dispatch_claim_request_id_sha256,
         command_dispatch_claim_request_id_sha256,
         authority_dispatch_claimed_at, controller_service_name,
         controller_enable_operation_id_sha256,
         controller_baseline_version_id, controller_enabled_version_id,
         send_attempt_limit, retry_limit, missing_readback_allows_resend,
         application_dispatch_consumption_credential_id_sha256,
         application_dispatch_consumption_request_id_sha256,
         command_dispatch_consumption_request_id_sha256,
         dispatch_consumption_digest_sha256, consumption_state
       ) VALUES (
         ?1, 1,
         'cinatoken-relay-container-shard-placement-dispatch-consumption-v1',
         ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
         ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
         ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37
       )`,
    )
    .run(
      values.ticketIdSha256,
      values.authorizationIdSha256,
      values.campaignId,
      values.applicationDatabaseIdentitySha256,
      values.applicationVersionId,
      values.applicationGrantDigestSha256,
      values.authorityClaimDigestSha256,
      values.authorityDispatchOutboxDigestSha256,
      values.applicationGrantReceiptDigestSha256,
      values.operationFiveStartReceiptSha256,
      values.authorityDispatchClaimDigestSha256,
      values.authorityDatabaseIdentitySha256,
      values.authorityLedgerIdentitySha256,
      values.authorityLedgerHeadSha256,
      values.authorityVersionId,
      values.dispatchOwnerSha256,
      values.leaseTokenSha256,
      values.leaseGeneration,
      values.leaseExpiresAt,
      values.normalDeadlineAt,
      values.permitExpiresAt,
      values.dispatchClaimCredentialIdSha256,
      values.dispatchClaimRequestIdSha256,
      values.commandDispatchClaimRequestIdSha256,
      values.authorityDispatchClaimedAt,
      values.controllerServiceName,
      values.controllerEnableOperationIdSha256,
      values.controllerBaselineVersionId,
      values.controllerEnabledVersionId,
      values.sendAttemptLimit,
      values.retryLimit,
      values.missingReadbackAllowsResend,
      values.applicationDispatchConsumptionCredentialIdSha256,
      values.applicationDispatchConsumptionRequestIdSha256,
      values.commandDispatchConsumptionRequestIdSha256,
      values.dispatchConsumptionDigestSha256,
      values.consumptionState,
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
