import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const migrationSql = readFileSync(join(
  import.meta.dir,
  "..",
  "services",
  "controller-deployment-gateway",
  "migrations",
  "0001_controller_deployment_gateway.sql",
), "utf8");

describe("controller deployment Gateway migration", () => {
  test("installs the isolated append-only evidence catalog", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    const identities = database.query(`
      SELECT type || ':' || name AS identity
      FROM sqlite_master
      WHERE (
        name LIKE 'controller_deployment_gateway_%'
        OR name = 'idx_controller_deployment_gateway_observations_operation'
      )
      ORDER BY identity
    `).all().map((row) => row.identity);
    expect(identities).toContain(
      "table:controller_deployment_gateway_operations",
    );
    expect(identities).toContain(
      "table:controller_deployment_gateway_dispatches",
    );
    expect(identities).toContain(
      "table:controller_deployment_gateway_outcomes",
    );
    expect(identities).toContain(
      "table:controller_deployment_gateway_observations",
    );
    expect(identities.filter((identity) => identity.startsWith("trigger:")))
      .toHaveLength(12);
  });

  test("preserves operation, dispatch, outcome, and observation evidence", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    insertOperation(database);
    insertDispatch(database);
    insertOutcome(database);
    insertObservation(database);
    for (const [table, mutation] of [
      [
        "controller_deployment_gateway_operations",
        "command_json = '{\"changed\":true}'",
      ],
      [
        "controller_deployment_gateway_dispatches",
        "mutation_body = '{\"changed\":true}'",
      ],
      [
        "controller_deployment_gateway_outcomes",
        "classification = 'ambiguous'",
      ],
      [
        "controller_deployment_gateway_observations",
        "classification = 'baseline_observed'",
      ],
    ]) {
      expect(() => database.query(
        `UPDATE ${table} SET ${mutation}`,
      ).run()).toThrow(/immutable/);
      expect(() => database.query(`DELETE FROM ${table}`).run()).toThrow(
        /append-preserved/,
      );
    }
  });

  test("rejects an accepted outcome without definite 2xx evidence", () => {
    using database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migrationSql);
    insertOperation(database);
    insertDispatch(database);
    expect(() => database.query(`
      INSERT INTO controller_deployment_gateway_outcomes (
        gateway_idempotency_key_sha256, classification, http_status,
        response_body_sha256, response_request_id_sha256, response_bytes,
        recorded_at
      ) VALUES (?, 'accepted', 429, ?, NULL, 10, unixepoch())
    `).run("1".repeat(64), "e".repeat(64))).toThrow();
  });
});

function insertOperation(database) {
  database.query(`
    INSERT INTO controller_deployment_gateway_operations (
      gateway_idempotency_key_sha256, command_digest_sha256, command_json,
      authorization_id_sha256, controller_enable_operation_id_sha256,
      authority_attempt_digest_sha256, send_started_event_digest_sha256,
      controller_service_name, baseline_version_id, target_version_id,
      account_id_sha256, gateway_profile_version,
      create_credential_id_sha256, create_request_id_sha256, created_at
    ) VALUES (?, ?, '{}', ?, ?, ?, ?, 'controller-staging', 'base', 'target',
      ?, 1, ?, ?, unixepoch())
  `).run(
    "1".repeat(64),
    "2".repeat(64),
    "3".repeat(64),
    "4".repeat(64),
    "5".repeat(64),
    "6".repeat(64),
    "7".repeat(64),
    "8".repeat(64),
    "9".repeat(64),
  );
}

function insertDispatch(database) {
  database.query(`
    INSERT INTO controller_deployment_gateway_dispatches (
      gateway_idempotency_key_sha256, mutation_request_sha256,
      mutation_body, mutation_annotation, endpoint_path,
      dispatch_semantics, authorized_at
    ) VALUES (?, ?, '{}', 'annotation',
      '/client/v4/accounts/account/workers/scripts/controller-staging/deployments',
      'unique_mutation_authority_persisted_network_may_not_have_occurred',
      unixepoch())
  `).run("1".repeat(64), "a".repeat(64));
}

function insertOutcome(database) {
  database.query(`
    INSERT INTO controller_deployment_gateway_outcomes (
      gateway_idempotency_key_sha256, classification, http_status,
      response_body_sha256, response_request_id_sha256, response_bytes,
      recorded_at
    ) VALUES (?, 'accepted', 200, ?, NULL, 10, unixepoch())
  `).run("1".repeat(64), "b".repeat(64));
}

function insertObservation(database) {
  database.query(`
    INSERT INTO controller_deployment_gateway_observations (
      gateway_idempotency_key_sha256, status_credential_id_sha256,
      status_request_id_sha256, classification, deployments_http_status,
      version_http_status, deployment_set_sha256, target_version_sha256,
      response_request_id_sha256, observation_digest_sha256, recorded_at
    ) VALUES (?, ?, ?, 'target_observed', 200, 200, ?, ?, NULL, ?, unixepoch())
  `).run(
    "1".repeat(64),
    "c".repeat(64),
    "d".repeat(64),
    "e".repeat(64),
    "f".repeat(64),
    "0".repeat(64),
  );
}
