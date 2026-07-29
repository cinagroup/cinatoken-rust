import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  executionRepositorySqlForTest,
} from "../src/execution_repository";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(testDirectory, "..", "migrations");
const migrationSql = readdirSync(migrationDirectory)
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(join(migrationDirectory, name), "utf8"));

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const source = {
  authorizationId: sha256("authorization"),
  permitSubject: sha256("permit-subject"),
  claimDigest: sha256("claim"),
  claimOwner: sha256("claim-owner"),
  leaseToken: sha256("lease-token"),
  ledgerIdentity: sha256("ledger-identity"),
  authorityDatabase: sha256("authority-database"),
  applicationDatabase: sha256("application-database"),
  applicationTicketId: sha256("application-ticket-id"),
  applicationTicketDigest: sha256("application-ticket-digest"),
  campaignId: sha256("campaign"),
  operationFourTerminal: sha256("operation-four-terminal"),
  operationFiveId: sha256("operation-five-id"),
  operationFiveRequest: sha256("operation-five-request"),
  operationSixId: sha256("operation-six-id"),
  operationStartCredential: sha256("operation-start-credential"),
  operationStartRequestId: sha256("operation-start-request-id"),
  operationStartReceipt: sha256("operation-five-start-receipt"),
  admissionConfirmation: sha256("admission-confirmation"),
  applicationActivation: sha256("application-activation"),
  attemptDigest: sha256("send-attempt"),
  sendStartedDigest: sha256("send-started"),
  dispatchDigest: sha256("gateway-dispatched"),
  acceptedDigest: sha256("gateway-accepted"),
  targetDigest: sha256("gateway-target"),
  stableDigest: sha256("gateway-stable"),
  observationDigest: sha256("deployment-state-observation"),
  deploymentSet: sha256("deployment-set"),
  targetVersionResponse: sha256("cloudflare-version-response-body"),
  controllerCommand: sha256("controller-command"),
  gatewayIdempotencyKey: sha256("gateway-idempotency-key"),
  stableGatewayRequest: sha256("stable-gateway-request"),
  stableGatewayResponse: sha256("stable-gateway-response"),
  stableCloudflareRequest: sha256("stable-cloudflare-request"),
  terminalWriterCredential: sha256("terminal-writer-credential"),
  terminalWriterRequest: sha256("terminal-writer-request"),
  terminalCommand: sha256("terminal-command"),
  terminalManifest: sha256(
    "manifest-excludes-after-ledger-and-terminal-receipt",
  ),
  terminalReceipt: sha256("operation-five-terminal-receipt"),
};

const retainedTriggerNames = [
  "shard_placement_authority_execution_receipt_insert_guard",
  "shard_placement_authority_execution_receipt_apply",
  "shard_placement_authority_operation_five_terminal_attempt_guard",
  "shard_placement_authority_operation_five_terminal_digest_guard",
  "shard_placement_authority_operation_five_terminal_gateway_guard",
  "shard_placement_authority_operation_five_terminal_insert_guard",
  "shard_placement_authority_operation_five_terminal_project",
  "shard_placement_authority_operation_five_gateway_closed_guard",
  "shard_placement_authority_operation_five_terminal_update_guard",
  "shard_placement_authority_operation_five_terminal_delete_guard",
] as const;

type FixtureOptions = {
  disableRequired?: boolean;
  expired?: boolean;
  laterGatewayEvent?: boolean;
  readbackOnly?: boolean;
  revoked?: boolean;
  gatewayVersionDrift?: boolean;
  takenOver?: boolean;
};

describe("operation-five terminal migration", () => {
  it("applies cleanly after the complete Authority migration history", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const sql of migrationSql) {
        database.exec(sql);
      }

      expect(
        database
          .prepare(
            `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name =
              'shard_placement_authority_operation_five_terminals'
        `,
          )
          .get(),
      ).toEqual({
        name: "shard_placement_authority_operation_five_terminals",
      });
      expect(
        database
          .prepare(
            `
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger'
            AND name LIKE
              'shard_placement_authority_operation_five_%terminal%'
          ORDER BY name
        `,
          )
          .all(),
      ).toEqual([
        {
          name: "shard_placement_authority_operation_five_terminal_attempt_guard",
        },
        {
          name: "shard_placement_authority_operation_five_terminal_delete_guard",
        },
        {
          name: "shard_placement_authority_operation_five_terminal_digest_guard",
        },
        {
          name: "shard_placement_authority_operation_five_terminal_gateway_guard",
        },
        {
          name: "shard_placement_authority_operation_five_terminal_insert_guard",
        },
        {
          name: "shard_placement_authority_operation_five_terminal_project",
        },
        {
          name: "shard_placement_authority_operation_five_terminal_update_guard",
        },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("atomically closes a fresh stable operation five and advances the claim", () => {
    const database = createTerminalDatabase();
    try {
      insertTerminal(database);

      expect(
        database
          .prepare(
            `
          SELECT controller_enabled_version_id, target_version_sha256,
                 ledger_head_before_sha256, ledger_head_after_sha256,
                 terminal_evidence_manifest_sha256,
                 generic_terminal_receipt_digest_sha256,
                 next_operation_ordinal, next_operation_id_sha256
          FROM shard_placement_authority_operation_five_terminals
        `,
          )
          .get(),
      ).toEqual({
        controller_enabled_version_id: "controller-enabled-v1",
        target_version_sha256: source.targetVersionResponse,
        ledger_head_before_sha256: source.operationStartReceipt,
        ledger_head_after_sha256: source.terminalReceipt,
        terminal_evidence_manifest_sha256: source.terminalManifest,
        generic_terminal_receipt_digest_sha256: source.terminalReceipt,
        next_operation_ordinal: 6,
        next_operation_id_sha256: source.operationSixId,
      });
      expect("controller-enabled-v1").not.toBe(source.targetVersionResponse);
      expect(source.terminalManifest).not.toBe(source.terminalReceipt);

      expect(
        database
          .prepare(
            `
          SELECT sequence, event_kind, operation_ordinal,
                 predecessor_receipt_sha256, response_sha256,
                 cloudflare_request_id_sha256, evidence_sha256,
                 outcome, receipt_credential_id_sha256,
                 request_id_sha256, receipt_digest_sha256
          FROM shard_placement_authority_execution_receipts
          WHERE sequence = 5
        `,
          )
          .get(),
      ).toEqual({
        sequence: 5,
        event_kind: "operation_terminal",
        operation_ordinal: 5,
        predecessor_receipt_sha256: source.operationStartReceipt,
        response_sha256: source.terminalManifest,
        cloudflare_request_id_sha256: source.stableCloudflareRequest,
        evidence_sha256: source.admissionConfirmation,
        outcome: "exact_success",
        receipt_credential_id_sha256: source.operationStartCredential,
        request_id_sha256: source.operationStartRequestId,
        receipt_digest_sha256: source.terminalReceipt,
      });

      expect(
        database
          .prepare(
            `
          SELECT status, ledger_version, ledger_head_sha256,
                 last_completed_ordinal, inflight_operation_ordinal,
                 inflight_operation_id_sha256, inflight_request_sha256,
                 inflight_started_generation,
                 inflight_started_owner_sha256,
                 inflight_started_lease_token_sha256,
                 inflight_readback_only
          FROM shard_placement_authority_execution_claims
        `,
          )
          .get(),
      ).toEqual({
        status: "running",
        ledger_version: 5,
        ledger_head_sha256: source.terminalReceipt,
        last_completed_ordinal: 5,
        inflight_operation_ordinal: null,
        inflight_operation_id_sha256: null,
        inflight_request_sha256: null,
        inflight_started_generation: null,
        inflight_started_owner_sha256: null,
        inflight_started_lease_token_sha256: null,
        inflight_readback_only: 0,
      });

      expect(() => insertTerminal(database)).toThrow();
      expect(() =>
        database
          .prepare(
            `
          UPDATE shard_placement_authority_operation_five_terminals
          SET terminal_writer_request_id_sha256 = ?
        `,
          )
          .run(sha256("changed-writer-request")),
      ).toThrow(/immutable_operation_five_terminal/);
      expect(() =>
        database
          .prepare(
            `
          DELETE FROM shard_placement_authority_operation_five_terminals
        `,
          )
          .run(),
      ).toThrow(/immutable_operation_five_terminal/);
      expect(() => insertPostClosureGatewayEvent(database)).toThrow(
        /operation_five_gateway_chain_closed/,
      );
      expect(terminalCount(database)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("keeps repository bind order aligned with migration 0007", () => {
    const database = createTerminalDatabase();
    try {
      const stable = database
        .prepare(
          `SELECT gateway_recorded_at
           FROM shard_placement_authority_operation_five_gateway_events
           WHERE attempt_digest_sha256 = ? AND event_sequence = 5`,
        )
        .get(source.attemptDigest) as { gateway_recorded_at: number };
      const row = terminalRow({
        stable_gateway_recorded_at: stable.gateway_recorded_at,
      });
      database
        .prepare(executionRepositorySqlForTest.insertOperationFiveTerminal)
        .run(...terminalRepositoryBindings(row));
      expect(terminalCount(database)).toBe(1);
      expect(
        database
          .prepare(
            `SELECT ledger_version, last_completed_ordinal,
                    ledger_head_sha256
             FROM shard_placement_authority_execution_claims`,
          )
          .get(),
      ).toEqual({
        ledger_version: 5,
        last_completed_ordinal: 5,
        ledger_head_sha256: source.terminalReceipt,
      });
    } finally {
      database.close();
    }
  });

  it("rejects closure when the stable event is no longer the chain head", () => {
    const database = createTerminalDatabase({
      laterGatewayEvent: true,
    });
    try {
      expect(() => insertTerminal(database)).toThrow(
        /operation_five_terminal_gateway_not_head/,
      );
      expectPristineTerminalState(database);
    } finally {
      database.close();
    }
  });

  it("rejects Authority and Gateway Worker version drift", () => {
    const authorityDrift = createTerminalDatabase();
    try {
      expect(() =>
        insertTerminal(authorityDrift, {
          authority_terminal_version_id: "authority-version-2",
        }),
      ).toThrow(/operation_five_terminal_attempt_mismatch/);
      expectPristineTerminalState(authorityDrift);
    } finally {
      authorityDrift.close();
    }

    const gatewayDrift = createTerminalDatabase({
      gatewayVersionDrift: true,
    });
    try {
      expect(() => insertTerminal(gatewayDrift)).toThrow(
        /operation_five_terminal_gateway_(mismatch|version_mismatch)/,
      );
      expectPristineTerminalState(gatewayDrift);
    } finally {
      gatewayDrift.close();
    }
  });

  it("rejects readback-only and revoked claims", () => {
    const readbackOnly = createTerminalDatabase({ readbackOnly: true });
    try {
      expect(() => insertTerminal(readbackOnly)).toThrow(
        /operation_five_terminal_source_mismatch/,
      );
      expectPristineTerminalState(readbackOnly);
    } finally {
      readbackOnly.close();
    }

    const revoked = createTerminalDatabase({ revoked: true });
    try {
      expect(() => insertTerminal(revoked)).toThrow(
        /operation_five_terminal_source_mismatch/,
      );
      expectPristineTerminalState(revoked);
    } finally {
      revoked.close();
    }
  });

  it("rejects disable-required, takeover, and expired normal execution", () => {
    for (const options of [
      { disableRequired: true },
      { takenOver: true },
      { expired: true },
    ]) {
      const database = createTerminalDatabase(options);
      try {
        expect(() => insertTerminal(database)).toThrow(
          /operation_five_terminal_source_mismatch/,
        );
        expectPristineTerminalState(database);
      } finally {
        database.close();
      }
    }
  });

  it("rolls back the sidecar when generic receipt projection fails", () => {
    const database = createTerminalDatabase();
    try {
      database.exec(`
        CREATE TRIGGER test_reject_operation_five_terminal_receipt
        BEFORE INSERT ON shard_placement_authority_execution_receipts
        FOR EACH ROW
        WHEN NEW.sequence = 5
        BEGIN
          SELECT RAISE(ABORT, 'test_projection_failure');
        END
      `);

      expect(() => insertTerminal(database)).toThrow(/test_projection_failure/);
      expectPristineTerminalState(database);
    } finally {
      database.close();
    }
  });
});

function createTerminalDatabase(options: FixtureOptions = {}): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const sql of migrationSql) {
    database.exec(sql);
  }

  const retainedTriggers = retainedTriggerNames.map((name) => {
    const row = database
      .prepare(
        `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'trigger' AND name = ?
    `,
      )
      .get(name) as { sql: string } | undefined;
    if (row === undefined) {
      throw new Error(`missing retained trigger: ${name}`);
    }
    return row.sql;
  });

  const triggerNames = database
    .prepare(
      `
    SELECT name
    FROM sqlite_master
    WHERE type = 'trigger'
  `,
    )
    .all() as Array<{ name: string }>;
  for (const { name } of triggerNames) {
    database.exec(`DROP TRIGGER "${name}"`);
  }

  database.exec("PRAGMA foreign_keys = OFF");
  seedTerminalPrerequisites(database, options);
  for (const sql of retainedTriggers) {
    database.exec(sql);
  }
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function seedTerminalPrerequisites(
  database: DatabaseSync,
  options: FixtureOptions,
): void {
  const now = databaseNow(database);
  const permitExpiresAt = now + 600;
  const status =
    options.readbackOnly || options.disableRequired
      ? "disable_required"
      : "running";

  insertRow(database, "shard_placement_authority_execution_claims", {
    authorization_id_sha256: source.authorizationId,
    permit_subject_digest_sha256: source.permitSubject,
    execution_nonce_sha256: sha256("execution-nonce"),
    application_ticket_id_sha256: source.applicationTicketId,
    application_ticket_digest_sha256: source.applicationTicketDigest,
    application_database_identity_sha256: source.applicationDatabase,
    authority_database_identity_sha256: source.authorityDatabase,
    campaign_id: source.campaignId,
    campaign_nonce_sha256: sha256("campaign-nonce"),
    claim_scope: "staging-controller-placement-v1",
    execution_plan_sha256: sha256("execution-plan"),
    release_sha256: sha256("release"),
    publication_sha256: sha256("publication"),
    execution_activation_sha256: sha256("execution-activation"),
    runner_build_sha256: sha256("runner-build"),
    claim_owner_sha256: source.claimOwner,
    lease_owner_sha256: source.claimOwner,
    ledger_identity_sha256: source.ledgerIdentity,
    lease_token_sha256: source.leaseToken,
    lease_generation: 1,
    lease_expires_at: now + 300,
    baseline_operation_id_sha256: sha256("baseline-operation"),
    baseline_terminal_digest_sha256: sha256("baseline-terminal"),
    preparation_operation_id_sha256: sha256("preparation-operation"),
    claim_operation_id_sha256: sha256("claim-operation"),
    operation_schedule_sha256: sha256("operation-schedule"),
    claim_credential_id_sha256: sha256("claim-credential"),
    claim_request_id_sha256: sha256("claim-request"),
    claim_digest_sha256: source.claimDigest,
    claim_acquired_receipt_digest_sha256: sha256("claim-receipt"),
    permit_expires_at: permitExpiresAt,
    normal_deadline_at: options.expired ? now - 1 : now + 300,
    recovery_deadline_at: permitExpiresAt + 600,
    status,
    ledger_version: 4,
    ledger_head_sha256: source.operationStartReceipt,
    last_completed_ordinal: 4,
    inflight_operation_ordinal: 5,
    inflight_operation_id_sha256: source.operationFiveId,
    inflight_request_sha256: source.operationFiveRequest,
    inflight_started_generation: 1,
    inflight_started_owner_sha256: source.claimOwner,
    inflight_started_lease_token_sha256: source.leaseToken,
    inflight_readback_only: options.readbackOnly ? 1 : 0,
    enable_intent_seen: 1,
    disable_confirmed: 0,
    application_activation_digest_sha256: source.applicationActivation,
    ticket_activation_confirmed: 1,
    renewal_count: 0,
    takeover_count: options.readbackOnly || options.takenOver ? 1 : 0,
    generated_at: now - 60,
  });

  for (let ordinal = 4; ordinal <= 14; ordinal += 1) {
    const operationId =
      ordinal === 5
        ? source.operationFiveId
        : ordinal === 6
          ? source.operationSixId
          : sha256(`operation-${ordinal}`);
    insertRow(database, "shard_placement_authority_execution_operations", {
      authorization_id_sha256: source.authorizationId,
      ordinal,
      operation_id_sha256: operationId,
      kind:
        ordinal === 4
          ? "activate_execution_ticket"
          : ordinal === 5
            ? "enable_controller_deployment"
            : ordinal === 14
              ? "disable_controller_deployment"
              : "probe_shard_readiness",
      shard_index: ordinal >= 6 && ordinal <= 13 ? ordinal - 6 : null,
    });
  }

  insertRow(database, "shard_placement_authority_execution_receipts", {
    authorization_id_sha256: source.authorizationId,
    sequence: 4,
    event_kind: "operation_started",
    claim_digest_sha256: source.claimDigest,
    execution_plan_sha256: sha256("execution-plan"),
    ledger_identity_sha256: source.ledgerIdentity,
    operation_ordinal: 5,
    operation_id_sha256: source.operationFiveId,
    operation_kind: "enable_controller_deployment",
    shard_index: null,
    predecessor_receipt_sha256: source.operationFourTerminal,
    request_sha256: source.operationFiveRequest,
    response_sha256: null,
    cloudflare_request_id_sha256: null,
    evidence_sha256: source.admissionConfirmation,
    safety_reason: null,
    outcome: "pending",
    lease_owner_sha256: source.claimOwner,
    lease_token_sha256: source.leaseToken,
    lease_generation: 1,
    lease_expires_at: now + 300,
    receipt_credential_id_sha256: source.operationStartCredential,
    request_id_sha256: source.operationStartRequestId,
    receipt_digest_sha256: source.operationStartReceipt,
    recorded_at: now,
  });

  insertRow(database, "shard_placement_authority_operation_five_admissions", {
    authorization_id_sha256: source.authorizationId,
    contract_version: 1,
    confirmation_contract:
      "cinatoken-shard-placement-authority-operation-five-admission-v1",
    claim_digest_sha256: source.claimDigest,
    application_ticket_id_sha256: source.applicationTicketId,
    application_ticket_digest_sha256: source.applicationTicketDigest,
    application_database_identity_sha256: source.applicationDatabase,
    application_activation_digest_sha256: source.applicationActivation,
    authority_activation_terminal_receipt_sha256: source.operationFourTerminal,
    authority_ledger_head_sha256: source.operationFourTerminal,
    authority_database_identity_sha256: source.authorityDatabase,
    authority_version_id: "authority-version-1",
    application_acknowledgement_digest_sha256: sha256(
      "application-acknowledgement",
    ),
    application_version_id: "application-version-1",
    application_read_credential_id_sha256: sha256(
      "application-read-credential",
    ),
    application_read_request_id_sha256: sha256("application-read-request"),
    application_response_sha256: sha256("application-response"),
    application_response_bytes: 512,
    enable_credential_id_sha256: source.operationStartCredential,
    enable_request_id_sha256: source.operationStartRequestId,
    command_enable_request_id_sha256: sha256("command-enable-request"),
    enable_operation_request_sha256: source.operationFiveRequest,
    confirmation_digest_sha256: source.admissionConfirmation,
    operation_start_receipt_digest_sha256: source.operationStartReceipt,
    confirmed_at: now,
  });

  insertRow(
    database,
    "shard_placement_authority_operation_five_send_attempts",
    {
      authorization_id_sha256: source.authorizationId,
      contract_version: 1,
      attempt_contract:
        "cinatoken-shard-placement-authority-operation-five-send-attempt-v1",
      attempt_generation: 1,
      retry_count: 0,
      retry_limit: 0,
      send_attempt_limit: 1,
      send_authority_state: "granted",
      claim_digest_sha256: source.claimDigest,
      authority_dispatch_claim_digest_sha256: sha256(
        "authority-dispatch-claim",
      ),
      dispatch_consumption_receipt_digest_sha256: sha256(
        "dispatch-consumption-receipt",
      ),
      application_dispatch_consumption_digest_sha256: sha256(
        "application-dispatch-consumption",
      ),
      application_ticket_id_sha256: source.applicationTicketId,
      campaign_id: source.campaignId,
      application_database_identity_sha256: source.applicationDatabase,
      application_version_id: "application-version-1",
      authority_database_identity_sha256: source.authorityDatabase,
      authority_ledger_identity_sha256: source.ledgerIdentity,
      authority_ledger_head_sha256: source.operationStartReceipt,
      authority_version_id: "authority-version-1",
      dispatch_owner_sha256: source.claimOwner,
      lease_token_sha256: source.leaseToken,
      lease_generation: 1,
      controller_service_name: "container-controller-staging",
      controller_enable_operation_id_sha256: source.operationFiveId,
      controller_baseline_version_id: "controller-baseline-v1",
      controller_enabled_version_id: "controller-enabled-v1",
      controller_command_contract:
        "cinatoken-controller-deployment-gateway-enable-command-v1",
      controller_command_digest_sha256: source.controllerCommand,
      gateway_idempotency_contract:
        "cinatoken-controller-deployment-gateway-idempotency-v1",
      gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
      send_credential_id_sha256: sha256("send-credential"),
      send_request_id_sha256: sha256("send-request"),
      command_send_attempt_request_id_sha256: sha256(
        "command-send-attempt-request",
      ),
      controller_request_sent: 0,
      gateway_request_sent: 0,
      attempt_digest_sha256: source.attemptDigest,
      created_at: now,
    },
  );

  const gatewayDigests = [
    source.sendStartedDigest,
    source.dispatchDigest,
    source.acceptedDigest,
    source.targetDigest,
    source.stableDigest,
  ];
  const eventKinds = [
    "send_started",
    "gateway_create_dispatched",
    "gateway_create_accepted",
    "gateway_status_target",
    "gateway_status_stable",
  ];
  for (let index = 0; index < gatewayDigests.length; index += 1) {
    insertRow(
      database,
      "shard_placement_authority_operation_five_send_attempt_events",
      {
        authorization_id_sha256: source.authorizationId,
        attempt_digest_sha256: source.attemptDigest,
        event_sequence: index + 1,
        contract_version: 1,
        event_contract:
          "cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1",
        event_kind: eventKinds[index],
        from_state:
          index === 0 ? "consumption_receipted" : eventKinds[index - 1],
        to_state: eventKinds[index],
        event_semantics: `terminal_fixture_event_${index + 1}`,
        predecessor_event_digest_sha256:
          index === 0 ? "0".repeat(64) : gatewayDigests[index - 1],
        dispatch_consumption_receipt_digest_sha256: sha256(
          "dispatch-consumption-receipt",
        ),
        controller_command_digest_sha256: source.controllerCommand,
        gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
        controller_request_sent: 0,
        gateway_request_sent: index >= 2 ? 1 : 0,
        event_digest_sha256: gatewayDigests[index],
        recorded_at: now,
      },
    );
  }

  insertGatewayFixtureEvents(database, now, options.gatewayVersionDrift);

  if (options.laterGatewayEvent) {
    insertLaterFixtureEvents(database, now);
  }

  if (options.revoked) {
    insertRow(database, "shard_placement_authority_revocations", {
      authorization_id_sha256: source.authorizationId,
      permit_subject_digest_sha256: source.permitSubject,
      reason_code: "operator_abort",
      evidence_sha256: sha256("revocation-evidence"),
      revocation_event_sha256: sha256("revocation-event"),
      revoke_credential_id_sha256: sha256("revoke-credential"),
      recorded_at: now,
    });
  }
}

function insertGatewayFixtureEvents(
  database: DatabaseSync,
  now: number,
  gatewayVersionDrift = false,
): void {
  const common = {
    authorization_id_sha256: source.authorizationId,
    attempt_digest_sha256: source.attemptDigest,
    send_started_event_digest_sha256: source.sendStartedDigest,
    contract_version: 1,
    event_contract:
      "cinatoken-shard-placement-authority-operation-five-gateway-event-v1",
    gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
    controller_command_digest_sha256: source.controllerCommand,
  };

  insertRow(
    database,
    "shard_placement_authority_operation_five_gateway_events",
    {
      ...common,
      event_sequence: 2,
      event_kind: "gateway_create_dispatched",
      predecessor_event_digest_sha256: source.sendStartedDigest,
      gateway_credential_role: "create",
      gateway_credential_id_sha256: sha256("create-credential"),
      gateway_request_id_sha256: sha256("create-request"),
      mutation_request_sha256: sha256("mutation-request"),
      event_digest_sha256: source.dispatchDigest,
      recorded_at: now,
    },
  );
  insertRow(
    database,
    "shard_placement_authority_operation_five_gateway_events",
    {
      ...common,
      event_sequence: 3,
      event_kind: "gateway_create_accepted",
      predecessor_event_digest_sha256: source.dispatchDigest,
      gateway_credential_role: "create",
      gateway_credential_id_sha256: sha256("create-credential"),
      gateway_request_id_sha256: sha256("create-request"),
      gateway_response_sha256: sha256("accepted-gateway-response"),
      gateway_response_bytes: 800,
      gateway_version_id: gatewayVersionDrift
        ? "gateway-version-2"
        : "gateway-version-1",
      mutation_request_sha256: sha256("mutation-request"),
      result_classification: "accepted",
      result_http_status: 201,
      result_response_body_sha256: sha256("accepted-response-body"),
      result_response_request_id_sha256: sha256("accepted-response-request"),
      result_response_bytes: 400,
      gateway_recorded_at: now - 10,
      event_digest_sha256: source.acceptedDigest,
      recorded_at: now,
    },
  );
  insertRow(
    database,
    "shard_placement_authority_operation_five_gateway_events",
    {
      ...common,
      event_sequence: 4,
      event_kind: "gateway_status_target",
      predecessor_event_digest_sha256: source.acceptedDigest,
      gateway_credential_role: "status",
      gateway_credential_id_sha256: sha256("status-credential"),
      gateway_request_id_sha256: sha256("target-gateway-request"),
      gateway_response_sha256: sha256("target-gateway-response"),
      gateway_response_bytes: 900,
      gateway_version_id: "gateway-version-1",
      status_classification: "target_observed",
      deployments_http_status: 200,
      version_http_status: 200,
      deployment_set_sha256: source.deploymentSet,
      target_version_sha256: source.targetVersionResponse,
      status_response_request_id_sha256: sha256("target-cloudflare-request"),
      observation_digest_sha256: source.observationDigest,
      gateway_recorded_at: now - 5,
      target_stable: 0,
      required_matching_observations: 2,
      stability_minimum_seconds: 5,
      event_digest_sha256: source.targetDigest,
      recorded_at: now,
    },
  );
  insertRow(
    database,
    "shard_placement_authority_operation_five_gateway_events",
    {
      ...common,
      event_sequence: 5,
      event_kind: "gateway_status_stable",
      predecessor_event_digest_sha256: source.targetDigest,
      gateway_credential_role: "status",
      gateway_credential_id_sha256: sha256("status-credential"),
      gateway_request_id_sha256: source.stableGatewayRequest,
      gateway_response_sha256: source.stableGatewayResponse,
      gateway_response_bytes: 920,
      gateway_version_id: "gateway-version-1",
      status_classification: "target_observed",
      deployments_http_status: 200,
      version_http_status: 200,
      deployment_set_sha256: source.deploymentSet,
      target_version_sha256: source.targetVersionResponse,
      status_response_request_id_sha256: source.stableCloudflareRequest,
      observation_digest_sha256: source.observationDigest,
      gateway_recorded_at: now,
      target_stable: 1,
      required_matching_observations: 2,
      stability_minimum_seconds: 5,
      stability_predecessor_observation_digest_sha256: source.observationDigest,
      stability_predecessor_recorded_at: now - 5,
      event_digest_sha256: source.stableDigest,
      recorded_at: now,
    },
  );
}

function insertLaterFixtureEvents(database: DatabaseSync, now: number): void {
  const laterDigest = sha256("later-gateway-status");
  insertRow(
    database,
    "shard_placement_authority_operation_five_send_attempt_events",
    {
      authorization_id_sha256: source.authorizationId,
      attempt_digest_sha256: source.attemptDigest,
      event_sequence: 6,
      contract_version: 1,
      event_contract:
        "cinatoken-shard-placement-authority-operation-five-send-attempt-event-v1",
      event_kind: "gateway_status_target",
      from_state: "gateway_status_stable",
      to_state: "gateway_status_target",
      event_semantics: "terminal_fixture_later_event",
      predecessor_event_digest_sha256: source.stableDigest,
      dispatch_consumption_receipt_digest_sha256: sha256(
        "dispatch-consumption-receipt",
      ),
      controller_command_digest_sha256: source.controllerCommand,
      gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
      controller_request_sent: 0,
      gateway_request_sent: 1,
      event_digest_sha256: laterDigest,
      recorded_at: now,
    },
  );
  insertRow(
    database,
    "shard_placement_authority_operation_five_gateway_events",
    {
      authorization_id_sha256: source.authorizationId,
      attempt_digest_sha256: source.attemptDigest,
      send_started_event_digest_sha256: source.sendStartedDigest,
      event_sequence: 6,
      contract_version: 1,
      event_contract:
        "cinatoken-shard-placement-authority-operation-five-gateway-event-v1",
      event_kind: "gateway_status_target",
      predecessor_event_digest_sha256: source.stableDigest,
      gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
      controller_command_digest_sha256: source.controllerCommand,
      gateway_credential_role: "status",
      gateway_credential_id_sha256: sha256("status-credential"),
      gateway_request_id_sha256: sha256("later-gateway-request"),
      gateway_response_sha256: sha256("later-gateway-response"),
      gateway_response_bytes: 900,
      gateway_version_id: "gateway-version-1",
      status_classification: "target_observed",
      deployments_http_status: 200,
      version_http_status: 200,
      deployment_set_sha256: source.deploymentSet,
      target_version_sha256: source.targetVersionResponse,
      status_response_request_id_sha256: sha256("later-cloudflare-request"),
      observation_digest_sha256: source.observationDigest,
      gateway_recorded_at: now,
      target_stable: 0,
      required_matching_observations: 2,
      stability_minimum_seconds: 5,
      event_digest_sha256: laterDigest,
      recorded_at: now,
    },
  );
}

function terminalRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    authorization_id_sha256: source.authorizationId,
    contract_version: 1,
    terminal_contract:
      "cinatoken-shard-placement-authority-operation-five-terminal-v1",
    claim_digest_sha256: source.claimDigest,
    claim_owner_sha256: source.claimOwner,
    lease_owner_sha256: source.claimOwner,
    lease_token_sha256: source.leaseToken,
    lease_generation: 1,
    attempt_digest_sha256: source.attemptDigest,
    send_started_event_digest_sha256: source.sendStartedDigest,
    stable_gateway_event_sequence: 5,
    stable_gateway_event_digest_sha256: source.stableDigest,
    stable_gateway_predecessor_event_digest_sha256: source.targetDigest,
    stable_gateway_request_id_sha256: source.stableGatewayRequest,
    stable_gateway_response_sha256: source.stableGatewayResponse,
    stable_gateway_response_bytes: 920,
    stable_observation_digest_sha256: source.observationDigest,
    stable_status_response_request_id_sha256: source.stableCloudflareRequest,
    stable_gateway_recorded_at: 0,
    deployment_set_sha256: source.deploymentSet,
    target_version_sha256: source.targetVersionResponse,
    gateway_version_id: "gateway-version-1",
    controller_service_name: "container-controller-staging",
    controller_enabled_version_id: "controller-enabled-v1",
    controller_command_digest_sha256: source.controllerCommand,
    gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
    authority_database_identity_sha256: source.authorityDatabase,
    authority_ledger_identity_sha256: source.ledgerIdentity,
    authority_dispatch_version_id: "authority-version-1",
    authority_terminal_version_id: "authority-version-1",
    operation_five_id_sha256: source.operationFiveId,
    operation_five_request_sha256: source.operationFiveRequest,
    operation_start_receipt_digest_sha256: source.operationStartReceipt,
    operation_start_credential_id_sha256: source.operationStartCredential,
    operation_start_request_id_sha256: source.operationStartRequestId,
    admission_confirmation_digest_sha256: source.admissionConfirmation,
    terminal_writer_credential_id_sha256: source.terminalWriterCredential,
    terminal_writer_request_id_sha256: source.terminalWriterRequest,
    terminal_command_digest_sha256: source.terminalCommand,
    ledger_head_before_sha256: source.operationStartReceipt,
    ledger_head_after_sha256: source.terminalReceipt,
    terminal_evidence_manifest_sha256: source.terminalManifest,
    generic_receipt_sequence: 5,
    generic_terminal_receipt_digest_sha256: source.terminalReceipt,
    next_operation_ordinal: 6,
    next_operation_id_sha256: source.operationSixId,
    ...overrides,
  };
}

function insertTerminal(
  database: DatabaseSync,
  overrides: Record<string, unknown> = {},
): void {
  const stable = database
    .prepare(
      `
    SELECT gateway_recorded_at
    FROM shard_placement_authority_operation_five_gateway_events
    WHERE attempt_digest_sha256 = ? AND event_sequence = 5
  `,
    )
    .get(source.attemptDigest) as { gateway_recorded_at: number };
  insertRow(
    database,
    "shard_placement_authority_operation_five_terminals",
    terminalRow({
      stable_gateway_recorded_at: stable.gateway_recorded_at,
      ...overrides,
    }),
  );
}

function terminalRepositoryBindings(
  row: Record<string, unknown>,
): unknown[] {
  return [
    row.authorization_id_sha256,
    row.terminal_contract,
    row.claim_digest_sha256,
    row.claim_owner_sha256,
    row.lease_owner_sha256,
    row.lease_token_sha256,
    row.attempt_digest_sha256,
    row.send_started_event_digest_sha256,
    row.stable_gateway_event_sequence,
    row.stable_gateway_event_digest_sha256,
    row.stable_gateway_predecessor_event_digest_sha256,
    row.stable_gateway_request_id_sha256,
    row.stable_gateway_response_sha256,
    row.stable_gateway_response_bytes,
    row.stable_observation_digest_sha256,
    row.stable_status_response_request_id_sha256,
    row.stable_gateway_recorded_at,
    row.deployment_set_sha256,
    row.target_version_sha256,
    row.gateway_version_id,
    row.controller_service_name,
    row.controller_enabled_version_id,
    row.controller_command_digest_sha256,
    row.gateway_idempotency_key_sha256,
    row.authority_database_identity_sha256,
    row.authority_ledger_identity_sha256,
    row.authority_dispatch_version_id,
    row.authority_terminal_version_id,
    row.operation_five_id_sha256,
    row.operation_five_request_sha256,
    row.operation_start_receipt_digest_sha256,
    row.operation_start_credential_id_sha256,
    row.operation_start_request_id_sha256,
    row.admission_confirmation_digest_sha256,
    row.terminal_writer_credential_id_sha256,
    row.terminal_writer_request_id_sha256,
    row.terminal_command_digest_sha256,
    row.ledger_head_before_sha256,
    row.ledger_head_after_sha256,
    row.terminal_evidence_manifest_sha256,
    row.generic_terminal_receipt_digest_sha256,
    row.next_operation_id_sha256,
  ];
}

function insertPostClosureGatewayEvent(database: DatabaseSync): void {
  insertRow(
    database,
    "shard_placement_authority_operation_five_gateway_events",
    {
      authorization_id_sha256: source.authorizationId,
      attempt_digest_sha256: source.attemptDigest,
      send_started_event_digest_sha256: source.sendStartedDigest,
      event_sequence: 6,
      contract_version: 1,
      event_contract:
        "cinatoken-shard-placement-authority-operation-five-gateway-event-v1",
      event_kind: "gateway_status_ambiguous",
      predecessor_event_digest_sha256: source.stableDigest,
      gateway_idempotency_key_sha256: source.gatewayIdempotencyKey,
      controller_command_digest_sha256: source.controllerCommand,
      gateway_credential_role: "status",
      gateway_credential_id_sha256: sha256("status-credential"),
      gateway_request_id_sha256: sha256("post-close-request"),
      status_classification: "ambiguous",
      event_digest_sha256: sha256("post-close-event"),
    },
  );
}

function expectPristineTerminalState(database: DatabaseSync): void {
  expect(terminalCount(database)).toBe(0);
  expect(
    database
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM shard_placement_authority_execution_receipts
      WHERE sequence = 5
    `,
      )
      .get(),
  ).toEqual({ count: 0 });
  expect(
    database
      .prepare(
        `
      SELECT ledger_version, ledger_head_sha256, last_completed_ordinal,
             inflight_operation_ordinal
      FROM shard_placement_authority_execution_claims
    `,
      )
      .get(),
  ).toEqual({
    ledger_version: 4,
    ledger_head_sha256: source.operationStartReceipt,
    last_completed_ordinal: 4,
    inflight_operation_ordinal: 5,
  });
}

function terminalCount(database: DatabaseSync): number {
  const row = database
    .prepare(
      `
    SELECT COUNT(*) AS count
    FROM shard_placement_authority_operation_five_terminals
  `,
    )
    .get() as { count: number };
  return row.count;
}

function insertRow(
  database: DatabaseSync,
  table: string,
  row: Record<string, unknown>,
): void {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  database
    .prepare(
      `
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${placeholders})
  `,
    )
    .run(...(Object.values(row) as never[]));
}

function databaseNow(database: DatabaseSync): number {
  const row = database
    .prepare(
      `
    SELECT unixepoch() AS now
  `,
    )
    .get() as { now: number };
  return row.now;
}
