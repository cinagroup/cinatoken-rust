import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(testDirectory, "..", "migrations");
const prerequisiteSql = readFileSync(
  join(
    testDirectory,
    "workerd-send-migrations",
    "0001_send_attempt_prerequisites.sql",
  ),
  "utf8",
);
const sendAttemptSql = readFileSync(
  join(
    migrationDirectory,
    "0005_operation_five_send_attempts.sql",
  ),
  "utf8",
);
const gatewayEventSql = readFileSync(
  join(
    migrationDirectory,
    "0006_operation_five_gateway_events.sql",
  ),
  "utf8",
);
const completeMigrationSql = [
  "0001_shard_placement_authorizations.sql",
  "0002_shard_placement_execution_claims.sql",
  "0003_shard_placement_dispatch_consumptions.sql",
  "0004_shard_placement_dispatch_consumption_recoveries.sql",
].map((name) => readFileSync(join(migrationDirectory, name), "utf8"))
  .concat(sendAttemptSql, gatewayEventSql);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const source = {
  authorizationIdSha256: sha256("authorization"),
  attemptDigestSha256: sha256("attempt"),
  sendStartedEventDigestSha256: sha256("send-started"),
  claimDigestSha256: sha256("claim"),
  dispatchClaimDigestSha256: sha256("dispatch-claim"),
  consumptionReceiptDigestSha256: sha256("consumption-receipt"),
  applicationConsumptionDigestSha256:
    sha256("application-consumption"),
  applicationTicketIdSha256: sha256("application-ticket"),
  campaignId: sha256("campaign"),
  applicationDatabaseIdentitySha256:
    sha256("application-database"),
  authorityDatabaseIdentitySha256: sha256("authority-database"),
  authorityLedgerIdentitySha256: sha256("authority-ledger"),
  authorityLedgerHeadSha256: sha256("authority-ledger-head"),
  dispatchOwnerSha256: sha256("dispatch-owner"),
  leaseTokenSha256: sha256("lease-token"),
  controllerOperationIdSha256: sha256("controller-operation"),
  controllerCommandDigestSha256: sha256("controller-command"),
  gatewayIdempotencyKeySha256: sha256("gateway-idempotency"),
};

type GatewayEvent = {
  authorizationIdSha256: string;
  attemptDigestSha256: string;
  sendStartedEventDigestSha256: string;
  eventSequence: number;
  eventKind: string;
  predecessorEventDigestSha256: string;
  gatewayIdempotencyKeySha256: string;
  controllerCommandDigestSha256: string;
  gatewayCredentialRole: "create" | "status";
  gatewayCredentialIdSha256: string;
  gatewayRequestIdSha256: string;
  gatewayResponseSha256: string | null;
  gatewayResponseBytes: number | null;
  gatewayVersionId: string | null;
  mutationRequestSha256: string | null;
  resultClassification: "accepted" | "rejected" | "ambiguous" | null;
  resultHttpStatus: number | null;
  resultResponseBodySha256: string | null;
  resultResponseRequestIdSha256: string | null;
  resultResponseBytes: number | null;
  statusClassification:
    | "target_observed"
    | "baseline_observed"
    | "deployment_drift"
    | "ambiguous"
    | null;
  deploymentsHttpStatus: number | null;
  versionHttpStatus: number | null;
  deploymentSetSha256: string | null;
  targetVersionSha256: string | null;
  statusResponseRequestIdSha256: string | null;
  observationDigestSha256: string | null;
  gatewayRecordedAt: number | null;
  targetStable: number | null;
  requiredMatchingObservations: number | null;
  stabilityMinimumSeconds: number | null;
  stabilityPredecessorObservationDigestSha256: string | null;
  stabilityPredecessorRecordedAt: number | null;
  eventDigestSha256: string;
};

describe("operation-five controller deployment gateway event migration", () => {
  it("applies cleanly after the complete Authority migration history", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const migration of completeMigrationSql) {
        database.exec(migration);
      }
      expect(
        database.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'shard_placement_authority_operation_five_send_attempt_events',
              'shard_placement_authority_operation_five_gateway_events'
            )
          ORDER BY name
        `).all(),
      ).toEqual([
        {
          name:
            "shard_placement_authority_operation_five_gateway_events",
        },
        {
          name:
            "shard_placement_authority_operation_five_send_attempt_events",
        },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
    } finally {
      database.close();
    }
  });

  it("extends an existing send_started ledger and derives an ordered stable chain", () => {
    const database = createDatabase();
    try {
      expect(
        database.prepare(`
          SELECT event_sequence, event_kind, event_digest_sha256
          FROM shard_placement_authority_operation_five_send_attempt_events
        `).get(),
      ).toEqual({
        event_sequence: 1,
        event_kind: "send_started",
        event_digest_sha256: source.sendStartedEventDigestSha256,
      });

      const dispatched = createDispatched();
      insertGatewayEvent(database, dispatched);
      const accepted = createResult(database, dispatched, "accepted");
      insertGatewayEvent(database, accepted);
      const target = statusEvent(
        database,
        accepted,
        "target",
        databaseNow(database) - 5,
      );
      insertGatewayEvent(database, target);
      const stable = stableStatusEvent(database, target);
      insertGatewayEvent(database, stable);

      expect(
        database.prepare(`
          SELECT event_sequence, event_kind, from_state, to_state,
                 event_semantics, predecessor_event_digest_sha256,
                 controller_request_sent, gateway_request_sent
          FROM shard_placement_authority_operation_five_send_attempt_events
          ORDER BY event_sequence
        `).all(),
      ).toEqual([
        {
          event_sequence: 1,
          event_kind: "send_started",
          from_state: "consumption_receipted",
          to_state: "send_started",
          event_semantics:
            "unique_send_authority_persisted_network_may_not_have_occurred",
          predecessor_event_digest_sha256: "0".repeat(64),
          controller_request_sent: 0,
          gateway_request_sent: 0,
        },
        {
          event_sequence: 2,
          event_kind: "gateway_create_dispatched",
          from_state: "send_started",
          to_state: "gateway_create_dispatched",
          event_semantics:
            "unique_gateway_create_authority_persisted_network_may_not_have_occurred",
          predecessor_event_digest_sha256:
            source.sendStartedEventDigestSha256,
          controller_request_sent: 0,
          gateway_request_sent: 0,
        },
        {
          event_sequence: 3,
          event_kind: "gateway_create_accepted",
          from_state: "gateway_create_dispatched",
          to_state: "gateway_create_accepted",
          event_semantics:
            "gateway_create_accepted_status_readback_required",
          predecessor_event_digest_sha256:
            dispatched.eventDigestSha256,
          controller_request_sent: 0,
          gateway_request_sent: 1,
        },
        {
          event_sequence: 4,
          event_kind: "gateway_status_target",
          from_state: "gateway_create_accepted",
          to_state: "gateway_status_target",
          event_semantics: "gateway_status_target_observed",
          predecessor_event_digest_sha256:
            accepted.eventDigestSha256,
          controller_request_sent: 0,
          gateway_request_sent: 1,
        },
        {
          event_sequence: 5,
          event_kind: "gateway_status_stable",
          from_state: "gateway_status_target",
          to_state: "gateway_status_stable",
          event_semantics: "gateway_status_target_stable",
          predecessor_event_digest_sha256: target.eventDigestSha256,
          controller_request_sent: 0,
          gateway_request_sent: 1,
        },
      ]);
      expect(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM shard_placement_authority_operation_five_gateway_events
        `).get(),
      ).toEqual({ count: 4 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual(
        [],
      );
    } finally {
      database.close();
    }
  });

  it("admits every create result and status observation vocabulary", () => {
    for (const result of ["accepted", "rejected", "ambiguous"] as const) {
      const database = createDatabase();
      try {
        const dispatched = createDispatched();
        insertGatewayEvent(database, dispatched);
        insertGatewayEvent(
          database,
          createResult(database, dispatched, result),
        );
        expect(gatewayKinds(database)).toEqual([
          "gateway_create_dispatched",
          `gateway_create_${result}`,
        ]);
      } finally {
        database.close();
      }
    }

    for (
      const status of ["target", "baseline", "drift", "ambiguous"] as const
    ) {
      const database = createDatabase();
      try {
        const dispatched = createDispatched();
        insertGatewayEvent(database, dispatched);
        const accepted = createResult(database, dispatched, "accepted");
        insertGatewayEvent(database, accepted);
        insertGatewayEvent(
          database,
          statusEvent(database, accepted, status, databaseNow(database)),
        );
        expect(gatewayKinds(database).at(-1)).toBe(
          `gateway_status_${status}`,
        );
      } finally {
        database.close();
      }
    }
  });

  it("rejects missing, skipped, divergent, and cross-request predecessors", () => {
    const database = createDatabase();
    try {
      const dispatched = createDispatched();
      expect(() =>
        insertGatewayEvent(database, {
          ...dispatched,
          eventKind: "gateway_create_accepted",
        })
      ).toThrow();
      expect(() =>
        insertGatewayEvent(database, {
          ...dispatched,
          sendStartedEventDigestSha256: sha256("other-start"),
        })
      ).toThrow("operation_five_gateway_event_source_mismatch");

      insertGatewayEvent(database, dispatched);
      const accepted = createResult(database, dispatched, "accepted");
      expect(() =>
        insertGatewayEvent(database, {
          ...accepted,
          eventSequence: 4,
        })
      ).toThrow("operation_five_gateway_event_predecessor_mismatch");
      expect(() =>
        insertGatewayEvent(database, {
          ...accepted,
          predecessorEventDigestSha256: sha256("wrong-predecessor"),
        })
      ).toThrow("operation_five_gateway_event_predecessor_mismatch");
      expect(() =>
        insertGatewayEvent(database, {
          ...accepted,
          gatewayRequestIdSha256: sha256("different-create-request"),
        })
      ).toThrow("operation_five_gateway_create_result_source_mismatch");
      insertGatewayEvent(database, accepted);
      expect(() =>
        insertGatewayEvent(database, {
          ...statusEvent(
            database,
            accepted,
            "target",
            databaseNow(database),
          ),
          gatewayCredentialIdSha256:
            dispatched.gatewayCredentialIdSha256,
        })
      ).toThrow("operation_five_gateway_role_identity_collision");
      expect(gatewayKinds(database)).toEqual([
        "gateway_create_dispatched",
        "gateway_create_accepted",
      ]);
    } finally {
      database.close();
    }
  });

  it("enforces sha256, text, response, HTTP status, and D1 clock bounds", () => {
    for (const mutation of [
      (event: GatewayEvent): GatewayEvent => ({
        ...event,
        eventDigestSha256: "A".repeat(64),
      }),
      (event: GatewayEvent): GatewayEvent => ({
        ...event,
        gatewayCredentialIdSha256: "not-a-sha256",
      }),
      (event: GatewayEvent): GatewayEvent => ({
        ...event,
        mutationRequestSha256: null,
      }),
    ]) {
      const database = createDatabase();
      try {
        expect(() =>
          insertGatewayEvent(database, mutation(createDispatched()))
        ).toThrow();
      } finally {
        database.close();
      }
    }

    const acceptedDatabase = createDatabase();
    try {
      const dispatched = createDispatched();
      insertGatewayEvent(acceptedDatabase, dispatched);
      const accepted = createResult(
        acceptedDatabase,
        dispatched,
        "accepted",
      );
      expect(() =>
        insertGatewayEvent(acceptedDatabase, {
          ...accepted,
          resultHttpStatus: 500,
        })
      ).toThrow();
      expect(() =>
        insertGatewayEvent(acceptedDatabase, {
          ...accepted,
          gatewayResponseBytes: 65537,
        })
      ).toThrow();
      expect(() =>
        insertGatewayEvent(acceptedDatabase, {
          ...accepted,
          gatewayVersionId: "v".repeat(129),
        })
      ).toThrow();
      expect(() =>
        insertGatewayEventAt(
          acceptedDatabase,
          accepted,
          databaseNow(acceptedDatabase) - 300,
        )
      ).toThrow("operation_five_gateway_event_clock_mismatch");
    } finally {
      acceptedDatabase.close();
    }

    const rejectedDatabase = createDatabase();
    try {
      const dispatched = createDispatched();
      insertGatewayEvent(rejectedDatabase, dispatched);
      expect(() =>
        insertGatewayEvent(
          rejectedDatabase,
          {
            ...createResult(
              rejectedDatabase,
              dispatched,
              "rejected",
            ),
            resultHttpStatus: 429,
          },
        )
      ).toThrow();
    } finally {
      rejectedDatabase.close();
    }

    const statusDatabase = createDatabase();
    try {
      const dispatched = createDispatched();
      insertGatewayEvent(statusDatabase, dispatched);
      const accepted = createResult(
        statusDatabase,
        dispatched,
        "accepted",
      );
      insertGatewayEvent(statusDatabase, accepted);
      expect(() =>
        insertGatewayEvent(statusDatabase, {
          ...statusEvent(
            statusDatabase,
            accepted,
            "target",
            databaseNow(statusDatabase),
          ),
          deploymentsHttpStatus: 99,
        })
      ).toThrow();
    } finally {
      statusDatabase.close();
    }
  });

  it("requires a distinct immediately preceding target across the stability window", () => {
    const success = createDatabase();
    try {
      const dispatched = createDispatched();
      insertGatewayEvent(success, dispatched);
      const accepted = createResult(success, dispatched, "accepted");
      insertGatewayEvent(success, accepted);
      const target = statusEvent(
        success,
        accepted,
        "target",
        databaseNow(success) - 5,
      );
      insertGatewayEvent(success, target);
      insertGatewayEvent(success, stableStatusEvent(success, target));
      expect(gatewayKinds(success).at(-1)).toBe("gateway_status_stable");
    } finally {
      success.close();
    }

    for (
      const mutate of [
        (
          database: DatabaseSync,
          target: GatewayEvent,
          stable: GatewayEvent,
        ): GatewayEvent => ({
          ...stable,
          gatewayRecordedAt: target.gatewayRecordedAt! + 4,
        }),
        (
          _database: DatabaseSync,
          _target: GatewayEvent,
          stable: GatewayEvent,
        ): GatewayEvent => ({
          ...stable,
          stabilityPredecessorObservationDigestSha256:
            sha256("wrong-observation"),
        }),
        (
          _database: DatabaseSync,
          target: GatewayEvent,
          stable: GatewayEvent,
        ): GatewayEvent => ({
          ...stable,
          gatewayRequestIdSha256: target.gatewayRequestIdSha256,
        }),
      ]
    ) {
      const database = createDatabase();
      try {
        const dispatched = createDispatched();
        insertGatewayEvent(database, dispatched);
        const accepted = createResult(database, dispatched, "accepted");
        insertGatewayEvent(database, accepted);
        const target = statusEvent(
          database,
          accepted,
          "target",
          databaseNow(database) - 5,
        );
        insertGatewayEvent(database, target);
        const stable = stableStatusEvent(database, target);
        expect(() =>
          insertGatewayEvent(
            database,
            mutate(database, target, stable),
          )
        ).toThrow();
      } finally {
        database.close();
      }
    }

    const resetByBaseline = createDatabase();
    try {
      const dispatched = createDispatched();
      insertGatewayEvent(resetByBaseline, dispatched);
      const accepted = createResult(
        resetByBaseline,
        dispatched,
        "accepted",
      );
      insertGatewayEvent(resetByBaseline, accepted);
      const target = statusEvent(
        resetByBaseline,
        accepted,
        "target",
        databaseNow(resetByBaseline) - 10,
      );
      insertGatewayEvent(resetByBaseline, target);
      const baseline = statusEvent(
        resetByBaseline,
        target,
        "baseline",
        databaseNow(resetByBaseline) - 5,
      );
      insertGatewayEvent(resetByBaseline, baseline);
      expect(() =>
        insertGatewayEvent(
          resetByBaseline,
          stableStatusEvent(resetByBaseline, baseline),
        )
      ).toThrow(
        "operation_five_gateway_stability_predecessor_mismatch",
      );
    } finally {
      resetByBaseline.close();
    }
  });

  it("keeps both ledgers immutable and makes replay collisions non-destructive", () => {
    const database = createDatabase();
    try {
      const dispatched = createDispatched();
      insertGatewayEvent(database, dispatched);
      expect(() =>
        insertGatewayEvent(database, dispatched)
      ).toThrow();
      expect(() =>
        insertGatewayEvent(database, {
          ...dispatched,
          eventDigestSha256: sha256("dispatch-collision"),
        })
      ).toThrow();
      expect(gatewayKinds(database)).toEqual([
        "gateway_create_dispatched",
      ]);

      expect(() =>
        database.exec(`
          UPDATE shard_placement_authority_operation_five_gateway_events
          SET gateway_credential_role = 'status'
        `)
      ).toThrow("immutable_operation_five_gateway_event");
      expect(() =>
        database.exec(`
          DELETE FROM
            shard_placement_authority_operation_five_gateway_events
        `)
      ).toThrow("immutable_operation_five_gateway_event");
      expect(() =>
        database.exec(`
          UPDATE
            shard_placement_authority_operation_five_send_attempt_events
          SET to_state = 'rewritten'
          WHERE event_sequence = 2
        `)
      ).toThrow("immutable_operation_five_send_attempt_event");
      expect(() =>
        database.exec(`
          DELETE FROM
            shard_placement_authority_operation_five_send_attempt_events
          WHERE event_sequence = 2
        `)
      ).toThrow("immutable_operation_five_send_attempt_event");
      expect(
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM shard_placement_authority_operation_five_send_attempt_events
        `).get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(prerequisiteSql);
  database.exec(sendAttemptSql);
  seedSendAttempt(database);
  const before = database.prepare(`
    SELECT *
    FROM shard_placement_authority_operation_five_send_attempt_events
  `).get();
  database.exec(gatewayEventSql);
  expect(
    database.prepare(`
      SELECT *
      FROM shard_placement_authority_operation_five_send_attempt_events
    `).get(),
  ).toEqual(before);
  return database;
}

function seedSendAttempt(database: DatabaseSync): void {
  const expiresAt = databaseNow(database) + 600;
  database.prepare(`
    INSERT INTO shard_placement_authority_execution_claims (
      authorization_id_sha256, claim_digest_sha256, status,
      ledger_version, ledger_head_sha256, last_completed_ordinal,
      inflight_operation_ordinal, inflight_operation_id_sha256,
      inflight_readback_only, enable_intent_seen, disable_confirmed,
      application_ticket_id_sha256,
      application_database_identity_sha256,
      authority_database_identity_sha256, ledger_identity_sha256,
      claim_owner_sha256, lease_owner_sha256, lease_token_sha256,
      lease_generation, lease_expires_at, normal_deadline_at,
      permit_expires_at, renewal_count, takeover_count
    ) VALUES (
      ?, ?, 'running', 4, ?, 4, 5, ?, 0, 1, 0, ?, ?, ?, ?, ?, ?, ?,
      1, ?, ?, ?, 0, 0
    )
  `).run(
    source.authorizationIdSha256,
    source.claimDigestSha256,
    source.authorityLedgerHeadSha256,
    source.controllerOperationIdSha256,
    source.applicationTicketIdSha256,
    source.applicationDatabaseIdentitySha256,
    source.authorityDatabaseIdentitySha256,
    source.authorityLedgerIdentitySha256,
    source.dispatchOwnerSha256,
    source.dispatchOwnerSha256,
    source.leaseTokenSha256,
    expiresAt,
    expiresAt,
    expiresAt,
  );
  database.prepare(`
    INSERT INTO
      shard_placement_authority_operation_five_dispatch_claims (
        authorization_id_sha256, dispatch_claim_digest_sha256,
        claim_digest_sha256, application_ticket_id_sha256
      ) VALUES (?, ?, ?, ?)
  `).run(
    source.authorizationIdSha256,
    source.dispatchClaimDigestSha256,
    source.claimDigestSha256,
    source.applicationTicketIdSha256,
  );
  database.prepare(`
    INSERT INTO
      shard_placement_authority_operation_five_dispatch_consumptions (
        authorization_id_sha256, claim_digest_sha256,
        authority_dispatch_claim_digest_sha256,
        receipt_digest_sha256,
        application_dispatch_consumption_digest_sha256,
        application_ticket_id_sha256, campaign_id,
        application_database_identity_sha256, application_version_id,
        authority_database_identity_sha256,
        authority_ledger_identity_sha256,
        authority_ledger_head_sha256, authority_version_id,
        dispatch_owner_sha256, lease_token_sha256, lease_generation,
        lease_expires_at, normal_deadline_at, permit_expires_at,
        controller_service_name,
        controller_enable_operation_id_sha256,
        controller_baseline_version_id,
        controller_enabled_version_id, send_attempt_limit, retry_limit
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, 'application-version-1', ?, ?, ?,
        'authority-version-1', ?, ?, 1, ?, ?, ?,
        'container-controller-staging', ?,
        'controller-baseline-v1', 'controller-enabled-v1', 1, 0
      )
  `).run(
    source.authorizationIdSha256,
    source.claimDigestSha256,
    source.dispatchClaimDigestSha256,
    source.consumptionReceiptDigestSha256,
    source.applicationConsumptionDigestSha256,
    source.applicationTicketIdSha256,
    source.campaignId,
    source.applicationDatabaseIdentitySha256,
    source.authorityDatabaseIdentitySha256,
    source.authorityLedgerIdentitySha256,
    source.authorityLedgerHeadSha256,
    source.dispatchOwnerSha256,
    source.leaseTokenSha256,
    expiresAt,
    expiresAt,
    expiresAt,
    source.controllerOperationIdSha256,
  );
  database.prepare(`
    INSERT INTO
      shard_placement_authority_operation_five_send_attempts (
        authorization_id_sha256, contract_version, attempt_contract,
        attempt_generation, retry_count, retry_limit, send_attempt_limit,
        send_authority_state, claim_digest_sha256,
        authority_dispatch_claim_digest_sha256,
        dispatch_consumption_receipt_digest_sha256,
        application_dispatch_consumption_digest_sha256,
        application_ticket_id_sha256, campaign_id,
        application_database_identity_sha256, application_version_id,
        authority_database_identity_sha256,
        authority_ledger_identity_sha256,
        authority_ledger_head_sha256, authority_version_id,
        dispatch_owner_sha256, lease_token_sha256, lease_generation,
        controller_service_name,
        controller_enable_operation_id_sha256,
        controller_baseline_version_id,
        controller_enabled_version_id, controller_command_contract,
        controller_command_digest_sha256, gateway_idempotency_contract,
        gateway_idempotency_key_sha256, send_credential_id_sha256,
        send_request_id_sha256,
        command_send_attempt_request_id_sha256,
        controller_request_sent, gateway_request_sent,
        attempt_digest_sha256
      ) VALUES (
        ?, 1,
        'cinatoken-shard-placement-authority-operation-five-send-attempt-v1',
        1, 0, 0, 1, 'granted', ?, ?, ?, ?, ?, ?, ?,
        'application-version-1', ?, ?, ?, 'authority-version-1', ?, ?, 1,
        'container-controller-staging', ?,
        'controller-baseline-v1', 'controller-enabled-v1',
        'cinatoken-controller-deployment-gateway-enable-command-v1', ?,
        'cinatoken-controller-deployment-gateway-idempotency-v1', ?,
        ?, ?, ?, 0, 0, ?
      )
  `).run(
    source.authorizationIdSha256,
    source.claimDigestSha256,
    source.dispatchClaimDigestSha256,
    source.consumptionReceiptDigestSha256,
    source.applicationConsumptionDigestSha256,
    source.applicationTicketIdSha256,
    source.campaignId,
    source.applicationDatabaseIdentitySha256,
    source.authorityDatabaseIdentitySha256,
    source.authorityLedgerIdentitySha256,
    source.authorityLedgerHeadSha256,
    source.dispatchOwnerSha256,
    source.leaseTokenSha256,
    source.controllerOperationIdSha256,
    source.controllerCommandDigestSha256,
    source.gatewayIdempotencyKeySha256,
    sha256("send-credential"),
    sha256("send-request"),
    sha256("send-command-request"),
    source.attemptDigestSha256,
  );
  database.prepare(`
    INSERT INTO
      shard_placement_authority_operation_five_send_attempt_events (
        authorization_id_sha256, attempt_digest_sha256,
        event_sequence, contract_version, event_contract, event_kind,
        from_state, to_state, event_semantics,
        predecessor_event_digest_sha256,
        dispatch_consumption_receipt_digest_sha256,
        controller_command_digest_sha256,
        gateway_idempotency_key_sha256,
        controller_request_sent, gateway_request_sent,
        event_digest_sha256
      ) VALUES (
        ?, ?, 1, 1,
        'cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1',
        'send_started', 'consumption_receipted', 'send_started',
        'unique_send_authority_persisted_network_may_not_have_occurred',
        ?, ?, ?, ?, 0, 0, ?
      )
  `).run(
    source.authorizationIdSha256,
    source.attemptDigestSha256,
    "0".repeat(64),
    source.consumptionReceiptDigestSha256,
    source.controllerCommandDigestSha256,
    source.gatewayIdempotencyKeySha256,
    source.sendStartedEventDigestSha256,
  );
}

function createDispatched(): GatewayEvent {
  return {
    ...eventIdentity(
      2,
      "gateway_create_dispatched",
      source.sendStartedEventDigestSha256,
      "create-dispatched",
    ),
    gatewayCredentialRole: "create",
    gatewayCredentialIdSha256: sha256("create-credential"),
    gatewayRequestIdSha256: sha256("create-request"),
    gatewayResponseSha256: null,
    gatewayResponseBytes: null,
    gatewayVersionId: null,
    mutationRequestSha256: sha256("mutation-request"),
    resultClassification: null,
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification: null,
    deploymentsHttpStatus: null,
    versionHttpStatus: null,
    deploymentSetSha256: null,
    targetVersionSha256: null,
    statusResponseRequestIdSha256: null,
    observationDigestSha256: null,
    gatewayRecordedAt: null,
    targetStable: null,
    requiredMatchingObservations: null,
    stabilityMinimumSeconds: null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  };
}

function createResult(
  database: DatabaseSync,
  predecessor: GatewayEvent,
  classification: "accepted" | "rejected" | "ambiguous",
): GatewayEvent {
  const hasResponse = classification !== "ambiguous";
  return {
    ...eventIdentity(
      3,
      `gateway_create_${classification}`,
      predecessor.eventDigestSha256,
      `create-${classification}`,
    ),
    gatewayCredentialRole: "create",
    gatewayCredentialIdSha256: predecessor.gatewayCredentialIdSha256,
    gatewayRequestIdSha256: predecessor.gatewayRequestIdSha256,
    gatewayResponseSha256:
      hasResponse ? sha256(`gateway-${classification}-response`) : null,
    gatewayResponseBytes: hasResponse ? 768 : null,
    gatewayVersionId: hasResponse ? "gateway-version-1" : null,
    mutationRequestSha256: predecessor.mutationRequestSha256,
    resultClassification: classification,
    resultHttpStatus:
      classification === "accepted"
        ? 201
        : classification === "rejected"
        ? 400
        : null,
    resultResponseBodySha256:
      hasResponse ? sha256(`cloudflare-${classification}-body`) : null,
    resultResponseRequestIdSha256:
      hasResponse ? sha256(`cloudflare-${classification}-request`) : null,
    resultResponseBytes: hasResponse ? 512 : null,
    statusClassification: null,
    deploymentsHttpStatus: null,
    versionHttpStatus: null,
    deploymentSetSha256: null,
    targetVersionSha256: null,
    statusResponseRequestIdSha256: null,
    observationDigestSha256: null,
    gatewayRecordedAt: hasResponse ? databaseNow(database) : null,
    targetStable: null,
    requiredMatchingObservations: null,
    stabilityMinimumSeconds: null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  };
}

function statusEvent(
  database: DatabaseSync,
  predecessor: GatewayEvent,
  classification: "target" | "baseline" | "drift" | "ambiguous",
  gatewayRecordedAt: number,
): GatewayEvent {
  const structured = classification !== "ambiguous";
  const statusClassification = {
    target: "target_observed",
    baseline: "baseline_observed",
    drift: "deployment_drift",
    ambiguous: "ambiguous",
  }[classification] as GatewayEvent["statusClassification"];
  const sequence = predecessor.eventSequence + 1;
  return {
    ...eventIdentity(
      sequence,
      `gateway_status_${classification}`,
      predecessor.eventDigestSha256,
      `status-${classification}-${sequence}`,
    ),
    gatewayCredentialRole: "status",
    gatewayCredentialIdSha256: sha256("status-credential"),
    gatewayRequestIdSha256:
      sha256(`status-request-${classification}-${sequence}`),
    gatewayResponseSha256:
      structured
        ? sha256(`gateway-status-${classification}-${sequence}`)
        : null,
    gatewayResponseBytes: structured ? 900 : null,
    gatewayVersionId: structured ? "gateway-version-1" : null,
    mutationRequestSha256: null,
    resultClassification: null,
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification,
    deploymentsHttpStatus: structured ? 200 : null,
    versionHttpStatus: structured ? 200 : null,
    deploymentSetSha256:
      structured ? sha256(`deployment-set-${classification}`) : null,
    targetVersionSha256:
      structured ? sha256("target-version") : null,
    statusResponseRequestIdSha256:
      structured
        ? sha256(`status-response-request-${classification}`)
        : null,
    observationDigestSha256:
      structured
        ? sha256(`observation-${classification}-${sequence}`)
        : null,
    gatewayRecordedAt: structured ? gatewayRecordedAt : null,
    targetStable: structured ? 0 : null,
    requiredMatchingObservations: structured ? 2 : null,
    stabilityMinimumSeconds: structured ? 5 : null,
    stabilityPredecessorObservationDigestSha256: null,
    stabilityPredecessorRecordedAt: null,
  };
}

function stableStatusEvent(
  database: DatabaseSync,
  predecessor: GatewayEvent,
): GatewayEvent {
  const sequence = predecessor.eventSequence + 1;
  return {
    ...eventIdentity(
      sequence,
      "gateway_status_stable",
      predecessor.eventDigestSha256,
      `status-stable-${sequence}`,
    ),
    gatewayCredentialRole: "status",
    gatewayCredentialIdSha256: sha256("status-credential"),
    gatewayRequestIdSha256: sha256(`status-request-stable-${sequence}`),
    gatewayResponseSha256: sha256(`gateway-status-stable-${sequence}`),
    gatewayResponseBytes: 920,
    gatewayVersionId: "gateway-version-1",
    mutationRequestSha256: null,
    resultClassification: null,
    resultHttpStatus: null,
    resultResponseBodySha256: null,
    resultResponseRequestIdSha256: null,
    resultResponseBytes: null,
    statusClassification: "target_observed",
    deploymentsHttpStatus: 200,
    versionHttpStatus: 200,
    deploymentSetSha256: sha256(`deployment-set-stable-${sequence}`),
    targetVersionSha256: sha256("target-version"),
    statusResponseRequestIdSha256:
      sha256(`status-response-request-stable-${sequence}`),
    observationDigestSha256:
      predecessor.observationDigestSha256,
    gatewayRecordedAt: databaseNow(database),
    targetStable: 1,
    requiredMatchingObservations: 2,
    stabilityMinimumSeconds: 5,
    stabilityPredecessorObservationDigestSha256:
      predecessor.observationDigestSha256,
    stabilityPredecessorRecordedAt: predecessor.gatewayRecordedAt,
  };
}

function eventIdentity(
  eventSequence: number,
  eventKind: string,
  predecessorEventDigestSha256: string,
  digestLabel: string,
): Pick<
  GatewayEvent,
  | "authorizationIdSha256"
  | "attemptDigestSha256"
  | "sendStartedEventDigestSha256"
  | "eventSequence"
  | "eventKind"
  | "predecessorEventDigestSha256"
  | "gatewayIdempotencyKeySha256"
  | "controllerCommandDigestSha256"
  | "eventDigestSha256"
> {
  return {
    authorizationIdSha256: source.authorizationIdSha256,
    attemptDigestSha256: source.attemptDigestSha256,
    sendStartedEventDigestSha256:
      source.sendStartedEventDigestSha256,
    eventSequence,
    eventKind,
    predecessorEventDigestSha256,
    gatewayIdempotencyKeySha256:
      source.gatewayIdempotencyKeySha256,
    controllerCommandDigestSha256:
      source.controllerCommandDigestSha256,
    eventDigestSha256: sha256(digestLabel),
  };
}

function insertGatewayEvent(
  database: DatabaseSync,
  event: GatewayEvent,
): void {
  gatewayInsertStatement(database).run(...gatewayEventValues(event));
}

function insertGatewayEventAt(
  database: DatabaseSync,
  event: GatewayEvent,
  recordedAt: number,
): void {
  database.prepare(gatewayInsertSql(true)).run(
    ...gatewayEventValues(event),
    recordedAt,
  );
}

function gatewayInsertStatement(database: DatabaseSync) {
  return database.prepare(gatewayInsertSql());
}

function gatewayInsertSql(includeRecordedAt = false): string {
  const recordedAtColumn = includeRecordedAt ? ", recorded_at" : "";
  const recordedAtValue = includeRecordedAt ? ", ?" : "";
  return `
    INSERT INTO
      shard_placement_authority_operation_five_gateway_events (
        authorization_id_sha256, attempt_digest_sha256,
        send_started_event_digest_sha256, event_sequence,
        contract_version, event_contract, event_kind,
        predecessor_event_digest_sha256,
        gateway_idempotency_key_sha256,
        controller_command_digest_sha256,
        gateway_credential_role, gateway_credential_id_sha256,
        gateway_request_id_sha256, gateway_response_sha256,
        gateway_response_bytes, gateway_version_id,
        mutation_request_sha256, result_classification,
        result_http_status, result_response_body_sha256,
        result_response_request_id_sha256, result_response_bytes,
        status_classification, deployments_http_status,
        version_http_status, deployment_set_sha256,
        target_version_sha256, status_response_request_id_sha256,
        observation_digest_sha256, gateway_recorded_at, target_stable,
        required_matching_observations, stability_minimum_seconds,
        stability_predecessor_observation_digest_sha256,
        stability_predecessor_recorded_at, event_digest_sha256
        ${recordedAtColumn}
    ) VALUES (
      ?, ?, ?, ?, 1,
      'cinatoken-shard-placement-authority-operation-five-gateway-event-v1',
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?${recordedAtValue}
    )
  `;
}

function gatewayEventValues(event: GatewayEvent): Array<string | number | null> {
  return [
    event.authorizationIdSha256,
    event.attemptDigestSha256,
    event.sendStartedEventDigestSha256,
    event.eventSequence,
    event.eventKind,
    event.predecessorEventDigestSha256,
    event.gatewayIdempotencyKeySha256,
    event.controllerCommandDigestSha256,
    event.gatewayCredentialRole,
    event.gatewayCredentialIdSha256,
    event.gatewayRequestIdSha256,
    event.gatewayResponseSha256,
    event.gatewayResponseBytes,
    event.gatewayVersionId,
    event.mutationRequestSha256,
    event.resultClassification,
    event.resultHttpStatus,
    event.resultResponseBodySha256,
    event.resultResponseRequestIdSha256,
    event.resultResponseBytes,
    event.statusClassification,
    event.deploymentsHttpStatus,
    event.versionHttpStatus,
    event.deploymentSetSha256,
    event.targetVersionSha256,
    event.statusResponseRequestIdSha256,
    event.observationDigestSha256,
    event.gatewayRecordedAt,
    event.targetStable,
    event.requiredMatchingObservations,
    event.stabilityMinimumSeconds,
    event.stabilityPredecessorObservationDigestSha256,
    event.stabilityPredecessorRecordedAt,
    event.eventDigestSha256,
  ];
}

function databaseNow(database: DatabaseSync): number {
  return (
    database.prepare("SELECT unixepoch() AS now").get() as { now: number }
  ).now;
}

function gatewayKinds(database: DatabaseSync): string[] {
  return (
    database.prepare(`
      SELECT event_kind
      FROM shard_placement_authority_operation_five_gateway_events
      ORDER BY event_sequence
    `).all() as Array<{ event_kind: string }>
  ).map((row) => row.event_kind);
}
