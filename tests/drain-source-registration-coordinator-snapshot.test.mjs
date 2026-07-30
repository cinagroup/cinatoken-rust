import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "bun:test";

const source = readFileSync(
  "crates/worker/src/d1_repositories.rs",
  "utf8",
);
const globalScope =
  "53481a32b6f9f49915477efcfca093d0f504943bf27e1a870dbcc1a0a2d69251";

function digest(character) {
  return character.repeat(64);
}

function snapshotSql() {
  const functionStart = source.indexOf(
    "pub(crate) async fn relay_container_drain_source_registration_phase_snapshot",
  );
  const marker = source.indexOf("WITH latest_ledger AS (", functionStart);
  const start = source.lastIndexOf('r#"', marker);
  const end = source.indexOf('"#', marker);
  if (functionStart < 0 || marker < 0 || start < functionStart || end < marker) {
    throw new Error("registration phase snapshot SQL is missing");
  }
  return source.slice(start + 3, end);
}

function sqliteType(value) {
  return typeof value === "number" ? "INTEGER" : "TEXT";
}

function createTable(database, name, prototype) {
  const columns = Object.entries(prototype)
    .map(([column, value]) => `${column} ${sqliteType(value)}`)
    .join(", ");
  database.exec(`CREATE TABLE ${name} (${columns})`);
}

function insertRow(database, name, row) {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  database
    .query(
      `INSERT INTO ${name} (${columns.join(", ")}) VALUES (${placeholders})`,
    )
    .run(...Object.values(row));
}

function fixtureDatabase() {
  const database = new Database(":memory:");
  const authorization = {
    authorization_id_sha256: digest("a"),
    contract_version: 1,
    authorization_contract:
      "relay-container-drain-source-authorization-v1",
    authorization_migration:
      "0072_relay_container_drain_source_authorization.sql",
    environment: "staging",
    scope_kind: "global",
    scope_id_sha256: globalScope,
    admission_fence_id_sha256: digest("b"),
    fence_generation: 1,
    expected_fence_state_digest_sha256: digest("c"),
    expected_head_version: 1,
    expected_head_digest_sha256: digest("d"),
    source_scan_id_sha256: digest("e"),
    collector_service_name: "drain-source-collector",
    collector_version_id: "collector-build-1",
    collector_run_id_sha256: digest("f"),
    started_by_credential_id_sha256: digest("1"),
    page_size: 128,
    shard_count: 16,
    accepted_source_schema_sha256: digest("2"),
    authorizer_issuer: "drain-source-authorizer",
    authorizer_key_id: "drain-source-authorizer-v1",
    authorizer_identity_sha256: digest("3"),
    authorizer_spki_sha256: digest("4"),
    authorization_subject_sha256: digest("5"),
    authorization_signature_envelope_sha256: digest("6"),
    execution_nonce_sha256: digest("7"),
    permit_issued_at: 2_100_000_000,
    permit_expires_at: 2_100_000_300,
    authorized_by_admin_id: 1,
    recorded_at: 2_100_000_001,
  };
  const root = {
    id: 1,
    role: 100,
    status: 1,
    session_epoch: 7,
    deleted_at: null,
  };
  const passkey = {
    id: 11,
    user_id: 1,
    credential_id: "Y3JlZGVudGlhbC1pZA==",
    public_key: "Y29zZS1wdWJsaWMta2V5",
    credential_registration_id_sha256: digest("8"),
    credential_id_sha256: digest("9"),
    credential_binding_sha256: digest("0"),
    credential_use_generation: 17,
    sign_count: 7,
    clone_warning: 0,
    user_present: 1,
    user_verified: 1,
    backup_eligible: 1,
    backup_state: 0,
    updated_at: 2_099_999_900,
    deleted_at: null,
  };
  const head = {
    environment: "staging",
    scope_kind: "global",
    scope_id_sha256: globalScope,
    current_fence_id_sha256: digest("b"),
    current_fence_generation: 1,
    head_version: 1,
    head_digest_sha256: digest("d"),
  };
  const fence = {
    admission_fence_id_sha256: digest("b"),
    fence_kind: "admission",
    environment: "staging",
    scope_kind: "global",
    scope_id_sha256: globalScope,
    fence_generation: 1,
    admission_open: 1,
    state_digest_sha256: digest("c"),
    closed_at: null,
  };
  const ledgerPrototype = {
    authority_ledger_identity_sha256: globalScope,
    receipt_sequence: 1,
    event_kind: "registration",
    authorization_id_sha256: digest("1"),
    predecessor_receipt_sha256: digest("2"),
    receipt_digest_sha256: digest("3"),
    recorded_at: 2_099_999_900,
  };

  createTable(
    database,
    "relay_container_drain_source_authorizations",
    authorization,
  );
  createTable(database, "users", root);
  createTable(database, "passkey_credentials", passkey);
  createTable(database, "relay_container_admission_scope_heads", head);
  createTable(database, "relay_container_admission_fences", fence);
  createTable(
    database,
    "relay_container_drain_source_receipt_ledger",
    ledgerPrototype,
  );
  for (const [name, prototype] of [
    [
      "relay_container_drain_source_registration_commands",
      { authorization_id_sha256: digest("a") },
    ],
    [
      "relay_container_drain_source_authorization_registrations",
      { authorization_id_sha256: digest("a") },
    ],
    [
      "relay_container_drain_source_authorization_claims",
      { authorization_id_sha256: digest("a") },
    ],
    [
      "relay_container_drain_source_terminal_receipts",
      { authorization_id_sha256: digest("a") },
    ],
    [
      "relay_container_drain_source_scans",
      { source_scan_id_sha256: digest("e") },
    ],
  ]) {
    createTable(database, name, prototype);
  }

  insertRow(
    database,
    "relay_container_drain_source_authorizations",
    authorization,
  );
  insertRow(database, "users", root);
  insertRow(database, "passkey_credentials", passkey);
  insertRow(database, "relay_container_admission_scope_heads", head);
  insertRow(database, "relay_container_admission_fences", fence);

  return {
    authorization,
    database,
    fence,
    head,
    ledgerPrototype,
    passkey,
    root,
  };
}

describe("drain source registration phase snapshot SQL", () => {
  it("prepares against the complete D1 schema through 0076", () => {
    const database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync("migrations/d1")
      .filter((name) => /^\d{4}_.*\.sql$/u.test(name))
      .sort()) {
      database.exec(readFileSync(`migrations/d1/${name}`, "utf8"));
      if (name.startsWith("0076_")) break;
    }

    expect(
      database
        .query(snapshotSql())
        .get(digest("a"), 1, globalScope),
    ).toBeNull();
  });

  it("projects every authority component and the current terminal ledger head", () => {
    const fixture = fixtureDatabase();
    const query = fixture.database.query(snapshotSql());
    const initial = query.get(digest("a"), 1, globalScope);

    expect(JSON.parse(initial.authorization_json)).toEqual(
      fixture.authorization,
    );
    expect(JSON.parse(initial.root_json)).toEqual(fixture.root);
    expect(JSON.parse(initial.passkey_json)).toEqual(fixture.passkey);
    expect(JSON.parse(initial.head_json)).toEqual(fixture.head);
    expect(JSON.parse(initial.fence_json)).toEqual(fixture.fence);
    expect(initial.latest_ledger_json).toBeNull();
    expect(initial.ledger_count).toBe(0);
    expect(initial.registration_command_count).toBe(0);
    expect(initial.registration_count).toBe(0);
    expect(initial.claim_count).toBe(0);
    expect(initial.terminal_count).toBe(0);
    expect(initial.source_scan_count).toBe(0);
    expect(initial.database_now).toBeGreaterThan(0);

    for (const receipt_sequence of [1, 2, 3]) {
      insertRow(
        fixture.database,
        "relay_container_drain_source_receipt_ledger",
        {
          ...fixture.ledgerPrototype,
          receipt_sequence,
          event_kind: receipt_sequence === 3 ? "terminal" : "registration",
          authorization_id_sha256: digest(String(receipt_sequence)),
          predecessor_receipt_sha256: digest(
            String(receipt_sequence + 3),
          ),
          receipt_digest_sha256: digest(String(receipt_sequence + 6)),
          recorded_at:
            fixture.ledgerPrototype.recorded_at + receipt_sequence,
        },
      );
    }
    const withLedger = query.get(digest("a"), 1, globalScope);
    expect(withLedger.ledger_count).toBe(3);
    expect(JSON.parse(withLedger.latest_ledger_json)).toEqual({
      ...fixture.ledgerPrototype,
      receipt_sequence: 3,
      event_kind: "terminal",
      authorization_id_sha256: digest("3"),
      predecessor_receipt_sha256: digest("6"),
      receipt_digest_sha256: digest("9"),
      recorded_at: fixture.ledgerPrototype.recorded_at + 3,
    });
  });
});
