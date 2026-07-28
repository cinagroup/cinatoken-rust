import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

const migrationPath = path.resolve(
  import.meta.dir,
  "../migrations/d1/0061_relay_container_shard_placement_attestations.sql",
);
const eventMigrationPath = path.resolve(
  import.meta.dir,
  "../migrations/d1/0062_relay_container_shard_placement_events.sql",
);
let migrationSql;
let eventMigrationSql;

beforeAll(async () => {
  migrationSql = await readFile(migrationPath, "utf8");
  eventMigrationSql = await readFile(eventMigrationPath, "utf8");
});

describe("Relay Container shard placement attestation D1 ledger", () => {
  test("creates one strict append-only schema after the frozen activation ABIs", () => {
    const db = databaseWithParents();
    db.exec(migrationSql);

    expect(
      db
        .query(
          `SELECT name FROM pragma_table_info(
             'relay_container_shard_placement_attestations'
           ) ORDER BY cid`,
        )
        .all()
        .map(({ name }) => name),
    ).toEqual([
      "placement_attestation_digest_sha256",
      "contract_version",
      "environment",
      "controller_service_name",
      "controller_version_id",
      "durable_object_namespace_binding",
      "durable_object_class",
      "jurisdiction",
      "canonical_name_sha256",
      "object_id_sha256",
      "shard_contract_version",
      "ring_generation",
      "shard_count",
      "shard_index",
      "instance_name",
      "activation_id",
      "campaign_id",
      "claim_digest_sha256",
      "readiness_result_sha256",
      "activation_digest_sha256",
      "consumption_digest_sha256",
      "recorded_at",
    ]);
    expect(schemaObjects(db)).toEqual([
      "index:idx_relay_container_shard_placement_attestations_candidate",
      "index:idx_relay_container_shard_placement_attestations_object",
      "table:relay_container_shard_placement_attestations",
      "trigger:relay_container_shard_placement_attestation_delete_guard",
      "trigger:relay_container_shard_placement_attestation_insert_guard",
      "trigger:relay_container_shard_placement_attestation_update_guard",
    ]);
    db.close();
  });

  test("accepts an exact default placement linked to one activation consumption", () => {
    const db = readyDatabase();
    insertAttestation(db);
    const row = db
      .query(
        `SELECT jurisdiction, controller_service_name, controller_version_id,
                object_id_sha256, recorded_at
         FROM relay_container_shard_placement_attestations`,
      )
      .get();
    expect(row).toEqual({
      jurisdiction: "default",
      controller_service_name: "cinatoken-container-controller-staging",
      controller_version_id: "controller-version-001",
      object_id_sha256: "a".repeat(64),
      recorded_at: expect.any(Number),
    });
    db.close();
  });

  test("rejects restricted placement until a versioned campaign authorizes it", () => {
    const db = readyDatabase();
    expect(() => insertAttestation(db, { jurisdiction: "eu" })).toThrow(
      "restricted shard placement requires activation campaign v2",
    );
    expect(
      db
        .query(
          "SELECT COUNT(*) AS count FROM relay_container_shard_placement_attestations",
        )
        .get().count,
    ).toBe(0);
    db.close();
  });

  test("rejects mismatched evidence, replacement, update, and deletion", () => {
    const db = readyDatabase();
    expect(() =>
      insertAttestation(db, { readinessResultSha256: "9".repeat(64) }),
    ).toThrow("shard placement attestation activation evidence mismatch");

    insertAttestation(db);
    expect(() =>
      insertAttestation(db, {
        placementDigestSha256: "8".repeat(64),
        objectIdSha256: "b".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      db
        .query(
          `UPDATE relay_container_shard_placement_attestations
           SET object_id_sha256 = ?`,
        )
        .run("b".repeat(64)),
    ).toThrow("shard placement attestations are immutable");
    expect(() =>
      db
        .query("DELETE FROM relay_container_shard_placement_attestations")
        .run(),
    ).toThrow("shard placement attestations are append-preserved");
    db.close();
  });

  test("backfills and appends a true insertion-order placement event ledger", () => {
    const backfill = readyDatabase();
    insertAttestation(backfill);
    backfill.exec(eventMigrationSql);
    expect(placementEvents(backfill)).toEqual([
      {
        placement_event_sequence: 1,
        activation_id: 1,
        shard_index: 3,
      },
    ]);
    backfill.close();

    const db = databaseWithParents();
    db.exec(migrationSql);
    db.exec(eventMigrationSql);
    insertParentEvidence(db, { activationId: 100, shardIndex: 3 });
    insertAttestation(db, { activationId: 100, shardIndex: 3 });
    insertParentEvidence(db, { activationId: 2, shardIndex: 4 });
    insertAttestation(db, {
      placementDigestSha256: "8".repeat(64),
      objectIdSha256: "b".repeat(64),
      activationId: 2,
      shardIndex: 4,
    });
    expect(placementEvents(db)).toEqual([
      {
        placement_event_sequence: 1,
        activation_id: 100,
        shard_index: 3,
      },
      {
        placement_event_sequence: 2,
        activation_id: 2,
        shard_index: 4,
      },
    ]);
    const queryPlan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT placement_event_sequence
         FROM relay_container_shard_placement_events
         WHERE controller_version_id = ?
           AND ring_generation = 7
           AND campaign_id = ?
           AND placement_event_sequence <= 2
           AND placement_event_sequence > 0
         ORDER BY placement_event_sequence`,
      )
      .all("controller-version-001", "3".repeat(64))
      .map(({ detail }) => detail)
      .join(" ");
    expect(queryPlan).toContain(
      "idx_relay_container_shard_placement_events_candidate",
    );
    expect(() =>
      db
        .query(
          `UPDATE relay_container_shard_placement_events
           SET activation_id = 3
           WHERE placement_event_sequence = 1`,
        )
        .run(),
    ).toThrow("shard placement events are immutable");
    expect(() =>
      db.query("DELETE FROM relay_container_shard_placement_events").run(),
    ).toThrow("shard placement events are append-preserved");
    db.close();
  });
});

function databaseWithParents() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE relay_container_shard_activations (
      activation_id INTEGER PRIMARY KEY,
      controller_version_id TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      ring_generation INTEGER NOT NULL,
      shard_index INTEGER NOT NULL,
      activation_digest_sha256 TEXT NOT NULL
    );
    CREATE TABLE relay_container_shard_activation_campaign_consumptions (
      campaign_id TEXT NOT NULL,
      shard_index INTEGER NOT NULL,
      claim_digest_sha256 TEXT NOT NULL,
      readiness_result_sha256 TEXT NOT NULL,
      activation_digest_sha256 TEXT NOT NULL,
      consumption_digest_sha256 TEXT NOT NULL,
      environment TEXT NOT NULL,
      controller_version_id TEXT NOT NULL,
      shard_contract_version INTEGER NOT NULL,
      ring_generation INTEGER NOT NULL,
      shard_count INTEGER NOT NULL,
      instance_name TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      PRIMARY KEY (campaign_id, shard_index)
    ) WITHOUT ROWID;
  `);
  return db;
}

function readyDatabase() {
  const db = databaseWithParents();
  db.exec(migrationSql);
  insertParentEvidence(db, { activationId: 1, shardIndex: 3 });
  return db;
}

function insertParentEvidence(
  db,
  { activationId, shardIndex, campaignId = "3".repeat(64) },
) {
  const activationDigest = hash(`activation:${activationId}:${shardIndex}`);
  db.query(
    `INSERT INTO relay_container_shard_activations (
       activation_id, controller_version_id, runtime_build_id, ring_generation,
       shard_index, activation_digest_sha256
     ) VALUES (?, ?, ?, 7, ?, ?)`,
  ).run(
    activationId,
    "controller-version-001",
    "1".repeat(64),
    shardIndex,
    activationDigest,
  );
  db.query(
    `INSERT INTO relay_container_shard_activation_campaign_consumptions (
       campaign_id, shard_index, claim_digest_sha256, readiness_result_sha256,
       activation_digest_sha256, consumption_digest_sha256, environment,
       controller_version_id, shard_contract_version, ring_generation,
       shard_count, instance_name, runtime_build_id
     ) VALUES (?, ?, ?, ?, ?, ?, 'staging', ?, 1, 7, 32, ?, ?)`,
  ).run(
    campaignId,
    shardIndex,
    hash(`claim:${shardIndex}`),
    hash(`readiness:${shardIndex}`),
    activationDigest,
    hash(`consumption:${shardIndex}`),
    "controller-version-001",
    instanceName(shardIndex),
    "1".repeat(64),
  );
}

function insertAttestation(
  db,
  {
    placementDigestSha256 = "7".repeat(64),
    jurisdiction = "default",
    objectIdSha256 = "a".repeat(64),
    activationId = 1,
    shardIndex = 3,
    campaignId = "3".repeat(64),
    readinessResultSha256 = hash(`readiness:${shardIndex}`),
  } = {},
) {
  const instance = instanceName(shardIndex);
  db.query(
    `INSERT INTO relay_container_shard_placement_attestations (
       placement_attestation_digest_sha256, contract_version, environment,
       controller_service_name, controller_version_id,
       durable_object_namespace_binding, durable_object_class, jurisdiction,
       canonical_name_sha256, object_id_sha256, shard_contract_version,
       ring_generation, shard_count, shard_index, instance_name, activation_id,
       campaign_id, claim_digest_sha256, readiness_result_sha256,
       activation_digest_sha256, consumption_digest_sha256
     ) VALUES (
       ?, 1, 'staging', 'cinatoken-container-controller-staging',
       'controller-version-001', 'RELAY_SHARDS', 'RelayShardContainer', ?,
       ?, ?, 1, 7, 32, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    placementDigestSha256,
    jurisdiction,
    hash(instance),
    objectIdSha256,
    shardIndex,
    instance,
    activationId,
    campaignId,
    hash(`claim:${shardIndex}`),
    readinessResultSha256,
    hash(`activation:${activationId}:${shardIndex}`),
    hash(`consumption:${shardIndex}`),
  );
}

function placementEvents(db) {
  return db
    .query(
      `SELECT event.placement_event_sequence, event.activation_id,
              placement.shard_index
       FROM relay_container_shard_placement_events AS event
       JOIN relay_container_shard_placement_attestations AS placement
         USING (placement_attestation_digest_sha256)
       ORDER BY event.placement_event_sequence`,
    )
    .all();
}

function instanceName(shardIndex) {
  return `cinatoken-relay-shard-v1-${String(shardIndex).padStart(4, "0")}`;
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function schemaObjects(db) {
  return db
    .query(
      `SELECT type || ':' || name AS object
       FROM sqlite_master
       WHERE name LIKE 'relay_container_shard_placement_attestation%'
          OR name LIKE 'idx_relay_container_shard_placement_attestation%'
       ORDER BY type || ':' || name`,
    )
    .all()
    .map(({ object }) => object);
}
