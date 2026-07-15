#!/usr/bin/env python3
import argparse
import hashlib
import sqlite3
from pathlib import Path


REQUIRED_TABLES = [
    "users",
    "tokens",
    "channels",
    "abilities",
    "options",
    "logs",
    "tasks",
    "payment_events",
    "subscription_orders",
    "topups",
    "two_fa",
    "two_fa_backup_codes",
    "midjourneys",
    "models",
    "vendors",
    "prefill_groups",
    "custom_oauth_providers",
    "user_oauth_bindings",
    "checkins",
    "redemptions",
    "subscription_plans",
    "user_subscriptions",
    "subscription_pre_consume_records",
    "passkey_credentials",
    "realtime_settlement_replays",
    "realtime_billing_reservations",
    "realtime_billing_recovery_state",
    "relay_billing_reservations",
    "relay_billing_recovery_state",
    "relay_billing_finalization_incidents",
    "task_billing_intents",
    "task_billing_reconciliation_events",
    "task_poll_lease_control",
    "task_poll_family_cursors",
    "task_poll_recovery_events",
]

REQUIRED_COLUMNS = {
    "tasks": {
        "poll_owner",
        "poll_generation",
        "poll_lease_expires_at",
        "poll_applied_generation",
        "poll_write_revision",
        "next_poll_at",
        "poll_attempt_count",
        "poll_consecutive_failures",
        "poll_last_attempt_at",
        "poll_last_error_code",
        "poll_quarantined_at",
        "poll_quarantine_reason",
    },
    "midjourneys": {
        "poll_owner",
        "poll_generation",
        "poll_lease_expires_at",
        "poll_applied_generation",
        "poll_write_revision",
        "next_poll_at",
        "poll_attempt_count",
        "poll_consecutive_failures",
        "poll_last_attempt_at",
        "poll_last_error_code",
        "poll_quarantined_at",
        "poll_quarantine_reason",
    },
    "task_poll_lease_control": {
        "id",
        "contract_version",
        "authority_enabled",
        "enforcement_enabled",
        "updated_at",
    },
    "task_poll_family_cursors": {
        "family",
        "last_row_id",
        "round_high_watermark",
        "scan_generation",
        "updated_at",
    },
    "task_poll_recovery_events": {
        "resolution_key",
        "entity_kind",
        "entity_id",
        "public_task_id",
        "expected_poll_generation",
        "expected_poll_write_revision",
        "expected_quarantined_at",
        "expected_hard_timeout_at",
        "expected_quarantine_reason",
        "action",
        "reason",
        "evidence_reference",
        "evidence_sha256",
        "preview_token",
        "decision_sha256",
        "operator_id",
        "created_at",
    },
    "abilities": {"tag"},
    "logs": {"billing_finalization_event_id"},
    "topups": {"credited", "payment_provider"},
    "subscription_orders": {
        "money",
        "trade_no",
        "payment_method",
        "payment_provider",
        "create_time",
        "complete_time",
        "provider_payload",
    },
    "redemptions": {"credited"},
    "users": {"session_epoch"},
    "passkey_credentials": {
        "user_id",
        "credential_id",
        "public_key",
        "sign_count",
        "deleted_at",
    },
    "realtime_settlement_replays": {
        "replay_key",
        "session",
        "status",
        "user_id",
        "token_id",
        "channel_id",
        "model_name",
        "pre_consumed_quota",
        "final_quota",
        "created_at",
        "applied_at",
        "error",
    },
    "realtime_billing_reservations": {
        "reservation_key",
        "session",
        "client_event_id_hash",
        "reservation_sequence",
        "user_id",
        "token_id",
        "channel_id",
        "selected_group",
        "model_name",
        "pre_consumed_quota",
        "snapshot_json",
        "request_json",
        "username",
        "token_name",
        "client_ip",
        "request_id",
        "started_at",
        "endpoint_path",
        "status",
        "upstream_response_id_hash",
        "replay_key",
        "final_quota",
        "created_at",
        "updated_at",
        "settled_at",
        "refunded_at",
        "lease_expires_at",
        "bridge_segment",
        "recovery_attempt_count",
        "recovery_next_attempt_at",
        "recovery_last_attempt_at",
        "finalization_owner",
        "finalization_reason",
        "finalization_required_at",
        "reconciliation_id",
        "reconciliation_revision",
        "reconciliation_resolution",
        "reconciliation_resolution_key",
        "reconciliation_resolved_at",
        "reconciliation_operator_id",
        "reconciliation_evidence_sha256",
    },
    "realtime_billing_recovery_state": {
        "id",
        "last_started_at",
        "last_completed_at",
        "last_success_at",
        "last_candidates",
        "last_refunded",
        "last_recovery_required",
        "last_failed",
        "last_deferred",
        "updated_at",
    },
    "relay_billing_reservations": {
        "reservation_key",
        "user_id",
        "token_id",
        "model_name",
        "endpoint_path",
        "request_id_hash",
        "expr_hash",
        "billing_kind",
        "billing_snapshot_json",
        "candidate_group_count",
        "reservation_strategy",
        "pre_consumed_quota",
        "status",
        "channel_id",
        "selected_group",
        "selected_at",
        "final_quota",
        "finalization_reason",
        "request_accounted",
        "lease_expires_at",
        "owner_generation",
        "owner_deadline_at",
        "owner_lease_renewed_at",
        "recovery_attempt_count",
        "recovery_next_attempt_at",
        "recovery_last_attempt_at",
        "created_at",
        "updated_at",
        "settled_at",
        "refunded_at",
        "recovery_required_at",
    },
    "relay_billing_recovery_state": {
        "id",
        "last_started_at",
        "last_completed_at",
        "last_success_at",
        "last_candidates",
        "last_refunded",
        "last_recovery_required",
        "last_failed",
        "last_deferred",
        "updated_at",
    },
    "relay_billing_finalization_incidents": {
        "incident_id",
        "event_id",
        "queue_message_id",
        "payload_sha256",
        "payload_json",
        "classification",
        "status",
        "delivery_count",
        "first_seen_at",
        "last_seen_at",
        "replay_generation",
        "replay_attempt_count",
        "replay_lease_expires_at",
        "last_replay_at",
        "resolved_at",
        "resolution",
        "last_error",
    },
    "task_billing_intents": {
        "reservation_key",
        "task_kind",
        "public_task_id",
        "user_id",
        "token_id",
        "channel_id",
        "quota",
        "funding_source",
        "subscription_id",
        "billing_contract_json",
        "billing_contract_sha256",
        "attach_contract_json",
        "attach_contract_sha256",
        "status",
        "submit_state",
        "provider_kind",
        "provider_idempotency_key",
        "client_operation_key_sha256",
        "client_request_sha256",
        "provider_task_id",
        "request_accounted",
        "lease_expires_at",
        "submit_deadline_at",
        "owner_generation",
        "submit_attempt_count",
        "recovery_attempt_count",
        "recovery_last_error",
        "created_at",
        "updated_at",
        "attached_at",
        "settled_at",
        "refunded_at",
        "recovery_required_at",
        "reconciliation_id",
        "reconciliation_revision",
        "reconciliation_resolution",
        "reconciliation_resolution_key",
        "reconciliation_resolved_at",
        "reconciliation_operator_id",
        "reconciliation_evidence_sha256",
        "reconciliation_reason",
    },
    "task_billing_reconciliation_events": {
        "resolution_key",
        "reconciliation_id",
        "reservation_key",
        "reconciliation_revision",
        "action",
        "reason",
        "provider_task_id",
        "evidence_reference",
        "evidence_sha256",
        "preview_token",
        "decision_sha256",
        "operator_id",
        "created_at",
    },
}

REQUIRED_INDEXES = {
    "tasks": {
        "idx_tasks_poll_lease_due": False,
        "idx_tasks_poll_schedule_due": False,
        "idx_tasks_poll_quarantine_queue": False,
    },
    "midjourneys": {
        "idx_midjourneys_poll_lease_due": False,
        "idx_midjourneys_poll_schedule_due": False,
        "idx_midjourneys_poll_quarantine_queue": False,
    },
    "abilities": {"uq_abilities_group_model_channel": True},
    "logs": {"idx_logs_billing_finalization_event_id": True},
    "prefill_groups": {"uk_prefill_name": True},
    "subscription_orders": {"idx_subscription_orders_trade_no": True},
    "topups": {"idx_topups_payment_provider_status": False},
    "users": {"idx_users_session_epoch": False},
    "passkey_credentials": {
        "idx_passkey_credentials_user_id": False,
        "idx_passkey_credentials_credential_id": False,
    },
    "realtime_settlement_replays": {
        "idx_realtime_settlement_replays_user": False,
        "idx_realtime_settlement_replays_status": False,
    },
    "realtime_billing_reservations": {
        "idx_realtime_billing_reservations_session_status": False,
        "idx_realtime_billing_reservations_user_status": False,
        "idx_realtime_billing_reservations_replay_key": True,
        "idx_realtime_billing_reservations_response": True,
        "idx_realtime_billing_reservations_lease": False,
        "idx_realtime_billing_reservations_segment_status": False,
        "idx_realtime_billing_reservations_global_lease": False,
        "idx_realtime_billing_reservations_recent_outcome": False,
        "idx_realtime_billing_reservations_finalization_owner": False,
        "idx_realtime_billing_reconciliation_id": True,
        "idx_realtime_billing_reconciliation_resolution_key": True,
        "idx_realtime_billing_reconciliation_operator_queue": False,
    },
    "relay_billing_reservations": {
        "idx_relay_billing_reservations_global_lease": False,
        "idx_relay_billing_reservations_recent_outcome": False,
        "idx_relay_billing_reservations_recovery_required": False,
    },
    "relay_billing_finalization_incidents": {
        "idx_relay_billing_finalization_incidents_event": True,
        "idx_relay_billing_finalization_incidents_status": False,
    },
    "task_billing_intents": {
        "idx_task_billing_intents_status_lease": False,
        "idx_task_billing_intents_user_status": False,
        "idx_task_billing_intents_provider_task": True,
        "idx_task_billing_intent_reconciliation_id": True,
        "idx_task_billing_intent_reconciliation_resolution_key": True,
        "idx_task_billing_intent_reconciliation_queue": False,
        "idx_task_billing_intents_client_operation": True,
        "idx_task_billing_intents_provider_operation": True,
        "idx_task_billing_intents_submit_deadline": False,
    },
    "task_billing_reconciliation_events": {
        "idx_task_billing_reconciliation_event_identity": True,
    },
    "task_poll_recovery_events": {
        "idx_task_poll_recovery_events_entity": False,
        "idx_task_poll_recovery_events_revision": True,
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify D1 SQL with Python sqlite3.")
    parser.add_argument(
        "--schema",
        action="append",
        help="D1 schema SQL file; repeat to override the default full migration chain",
    )
    parser.add_argument(
        "--seed",
        action="append",
        help="Optional seed SQL file; repeat to execute multiple seed files",
    )
    args = parser.parse_args()

    schema_paths = (
        [Path(value) for value in args.schema]
        if args.schema
        else sorted(Path("migrations/d1").glob("*.sql"))
    )
    if not schema_paths:
        raise SystemExit("no D1 schema migrations found")
    for schema_path in schema_paths:
        if not schema_path.exists():
            raise SystemExit(f"schema file not found: {schema_path}")

    lease_guard_verified = False
    segment_guard_verified = False
    relay_owner_guard_verified = False
    flat_intent_guard_verified = False
    task_billing_intents_verified = False
    task_submit_reconciliation_verified = False
    task_submit_reconciliation_rollout_verified = False
    task_submit_operation_verified = False
    task_submit_operation_rollout_verified = False
    task_poll_lease_verified = False
    task_poll_lease_rollout_verified = False
    task_poll_schedule_verified = False
    task_poll_schedule_rollout_verified = False
    task_poll_recovery_verified = False
    task_poll_recovery_rollout_verified = False
    if not args.schema:
        verify_realtime_lease_migration_guard(schema_paths)
        lease_guard_verified = True
        verify_realtime_segment_migration_guard(schema_paths)
        segment_guard_verified = True
        verify_relay_owner_migration_guard(schema_paths)
        relay_owner_guard_verified = True
        verify_task_submit_reconciliation_rollout(schema_paths)
        task_submit_reconciliation_rollout_verified = True
        verify_task_submit_operation_rollout(schema_paths)
        task_submit_operation_rollout_verified = True
        verify_task_poll_lease_rollout(schema_paths)
        task_poll_lease_rollout_verified = True
        verify_task_poll_schedule_rollout(schema_paths)
        task_poll_schedule_rollout_verified = True
        verify_task_poll_recovery_rollout(schema_paths)
        task_poll_recovery_rollout_verified = True

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        try:
            conn.executescript(schema_path.read_text(encoding="utf-8"))
        except sqlite3.Error as error:
            raise SystemExit(f"migration failed: {schema_path}: {error}") from error

    if not args.schema:
        verify_flat_billing_intent_guard(conn)
        flat_intent_guard_verified = True
        verify_task_billing_intents(conn)
        task_billing_intents_verified = True
        verify_task_submit_reconciliation(conn)
        task_submit_reconciliation_verified = True
        verify_task_submit_operation(conn)
        task_submit_operation_verified = True
        verify_task_poll_lease(conn)
        task_poll_lease_verified = True
        verify_task_poll_schedule(conn)
        task_poll_schedule_verified = True
        verify_task_poll_recovery(conn)
        task_poll_recovery_verified = True

    missing = [
        table
        for table in REQUIRED_TABLES
        if not table_exists(conn, table)
    ]
    if missing:
        raise SystemExit(f"missing tables: {', '.join(missing)}")

    missing_columns = []
    for table, expected_columns in REQUIRED_COLUMNS.items():
        actual_columns = table_columns(conn, table)
        for column in sorted(expected_columns - actual_columns):
            missing_columns.append(f"{table}.{column}")
    if missing_columns:
        raise SystemExit(f"missing columns: {', '.join(missing_columns)}")

    invalid_indexes = []
    for table, expected_indexes in REQUIRED_INDEXES.items():
        actual_indexes = table_indexes(conn, table)
        for name, expected_unique in expected_indexes.items():
            actual_unique = actual_indexes.get(name)
            if actual_unique is None:
                invalid_indexes.append(f"{table}.{name} (missing)")
            elif actual_unique != expected_unique:
                invalid_indexes.append(
                    f"{table}.{name} (unique={actual_unique}, expected={expected_unique})"
                )
    if invalid_indexes:
        raise SystemExit(f"invalid indexes: {', '.join(invalid_indexes)}")

    message = (
        f"sqlite schema ok: {len(schema_paths)} migrations, "
        f"{len(REQUIRED_TABLES)} tables, "
        f"{sum(map(len, REQUIRED_COLUMNS.values()))} incremental columns, "
        f"{sum(map(len, REQUIRED_INDEXES.values()))} key indexes"
    )
    if lease_guard_verified:
        message += " + 0020 active-reservation guard"
    if segment_guard_verified:
        message += " + 0021 bridge-segment guard"
    if relay_owner_guard_verified:
        message += " + 0026 relay-owner drain guard"
    if flat_intent_guard_verified:
        message += " + 0029 flat-intent guard + 0030 immutable billing contract"
    if task_billing_intents_verified:
        message += " + 0031 task billing intent state machine"
    if task_submit_reconciliation_verified:
        message += " + 0032/0033 task submit reconciliation"
    if task_submit_reconciliation_rollout_verified:
        message += " + 0032 expand/0033 enforce rollout"
    if task_submit_operation_verified:
        message += " + 0038/0039 bounded task submit operation"
    if task_submit_operation_rollout_verified:
        message += " + 0038 expand/0039 enforce rollout"
    if task_poll_lease_verified:
        message += " + 0034/0035 generation-fenced task polling"
    if task_poll_lease_rollout_verified:
        message += " + 0034 expand/0035 enforce rollout"
    if task_poll_schedule_verified:
        message += " + 0036 persisted fair task polling"
    if task_poll_schedule_rollout_verified:
        message += " + 0036 default-inert scheduler rollout"
    if task_poll_recovery_verified:
        message += " + 0037 audited task poll recovery"
    if task_poll_recovery_rollout_verified:
        message += " + 0037 default-inert recovery rollout"

    if args.seed:
        for value in args.seed:
            seed_path = Path(value)
            if not seed_path.exists():
                raise SystemExit(f"seed file not found: {seed_path}")
            conn.executescript(seed_path.read_text(encoding="utf-8"))
        counts = {
            table: conn.execute(f"select count(*) from {table}").fetchone()[0]
            for table in ("users", "tokens", "channels", "abilities")
        }
        if counts != {"users": 1, "tokens": 1, "channels": 1, "abilities": 1}:
            raise SystemExit(f"unexpected dev seed counts: {counts}")
        message += (
            f" + {len(args.seed)} seed file(s) ok: "
            "users=1 tokens=1 channels=1 abilities=1"
        )

    print(message)
    return 0


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "select 1 from sqlite_master where type = 'table' and name = ?",
        (table,),
    ).fetchone()
    return row is not None


def trigger_exists(conn: sqlite3.Connection, trigger: str) -> bool:
    row = conn.execute(
        "select 1 from sqlite_master where type = 'trigger' and name = ?",
        (trigger,),
    ).fetchone()
    return row is not None


def verify_flat_billing_intent_guard(conn: sqlite3.Connection) -> None:
    for trigger in (
        "relay_flat_billing_snapshot_insert_guard",
        "relay_flat_billing_snapshot_update_guard",
        "relay_billing_contract_immutable_guard",
    ):
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"flat billing contract trigger missing: {trigger}")

    conn.execute(
        """
        INSERT INTO relay_billing_reservations (
          reservation_key, user_id, model_name, lease_expires_at, created_at, updated_at
        ) VALUES ('legacy-tiered-writer', 1, 'guard-model', 100, 1, 1)
        """
    )
    try:
        conn.execute(
            """
            INSERT INTO relay_billing_reservations (
              reservation_key, user_id, model_name, lease_expires_at, created_at, updated_at,
              billing_kind, billing_snapshot_json
            ) VALUES ('flat-empty-snapshot', 1, 'guard-model', 100, 1, 1, 'flat', '')
            """
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("0029 must reject a flat reservation without a frozen snapshot")

    conn.execute(
        """
        INSERT INTO relay_billing_reservations (
          reservation_key, user_id, model_name, lease_expires_at, created_at, updated_at,
          billing_kind, billing_snapshot_json
        ) VALUES ('flat-valid-snapshot', 1, 'guard-model', 100, 1, 1, 'flat', '{}')
        """
    )
    try:
        conn.execute(
            "UPDATE relay_billing_reservations SET billing_snapshot_json = '' "
            "WHERE reservation_key = 'flat-valid-snapshot'"
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise SystemExit("0029 must reject clearing a frozen flat billing snapshot")

    immutable_mutations = (
        "billing_snapshot_json = '{\"changed\":true}'",
        "expr_hash = 'flat-v2:changed'",
        "billing_kind = 'tiered_expr'",
        "pre_consumed_quota = pre_consumed_quota + 1",
        "model_name = 'changed-model'",
    )
    for mutation in immutable_mutations:
        try:
            conn.execute(
                "UPDATE relay_billing_reservations SET "
                f"{mutation} WHERE reservation_key = 'flat-valid-snapshot'"
            )
        except sqlite3.IntegrityError:
            continue
        raise SystemExit(f"0030 must reject billing contract mutation: {mutation}")


def verify_task_billing_intents(conn: sqlite3.Connection) -> None:
    for trigger in (
        "task_billing_intent_contract_immutable_guard",
        "task_billing_intent_insert_guard",
        "task_billing_intent_channel_delete_guard",
        "task_billing_intent_submit_transition_guard",
        "task_billing_intent_reserve_apply",
        "task_billing_intent_status_transition_guard",
        "task_billing_intent_attach_guard",
        "task_billing_intent_attach_accounting",
        "task_billing_intent_terminal_guard",
        "task_billing_intent_refund_guard",
        "task_billing_intent_refund_apply",
    ):
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0031 task billing intent trigger missing: {trigger}")

    user_id = 310031
    token_id = 310031
    channel_id = 310031
    conn.execute(
        """
        INSERT INTO users (
          id, username, password, quota, used_quota, request_count, created_at
        ) VALUES (?, 'sqlite-0031-user', 'not-used', 1000, 100, 7, 1)
        """,
        (user_id,),
    )
    conn.execute(
        """
        INSERT INTO tokens (
          id, user_id, "key", remain_quota, used_quota, accessed_time
        ) VALUES (?, ?, 'sqlite-0031-token', 800, 200, 1)
        """,
        (token_id, user_id),
    )
    conn.execute(
        """
        INSERT INTO channels (id, "key", name, used_quota)
        VALUES (?, 'sqlite-0031-channel-key', 'sqlite-0031-channel', 300)
        """,
        (channel_id,),
    )
    baseline = (1000, 100, 7, 800, 200, 300)

    expect_integrity_error(
        lambda: insert_task_billing_intent(
            conn,
            "0031-atomic-failure",
            user_id,
            token_id,
            channel_id,
            quota=900,
            created_at=1000,
        ),
        "0031 must reject a reserve when the token balance is insufficient",
        "task billing intent admission failed",
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        baseline,
        "failed reserve must not partially debit the wallet",
    )
    failed_rows = conn.execute(
        "SELECT count(*) FROM task_billing_intents WHERE reservation_key = ?",
        ("0031-atomic-failure",),
    ).fetchone()[0]
    if failed_rows != 0:
        raise SystemExit("0031 failed reserve unexpectedly persisted an intent")

    insert_task_billing_intent(
        conn,
        "0031-prepared-refund",
        user_id,
        token_id,
        channel_id,
        quota=40,
        created_at=1100,
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        (960, 100, 7, 760, 240, 300),
        "wallet and token reserve must apply atomically",
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', refunded_at = 1101, updated_at = 1101
        WHERE reservation_key = '0031-prepared-refund'
        """
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        baseline,
        "prepared refund must restore the wallet and token reserve",
    )

    insert_task_billing_intent(
        conn,
        "0031-submit-unknown",
        user_id,
        token_id,
        channel_id,
        quota=50,
        created_at=1200,
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitting', submit_attempt_count = 1, updated_at = 1201
        WHERE reservation_key = '0031-submit-unknown'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submit_unknown',
            recovery_last_error = 'provider outcome unknown',
            updated_at = 1202
        WHERE reservation_key = '0031-submit-unknown'
        """
    )
    assert_task_billing_state(
        conn,
        "0031-submit-unknown",
        "reserved",
        "submit_unknown",
        "submitting to submit_unknown must retain the reserve",
    )
    unknown_accounting = (950, 100, 7, 750, 250, 300)
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        unknown_accounting,
        "submit_unknown must not automatically refund",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE task_billing_intents
            SET status = 'refunded', refunded_at = 1203, updated_at = 1203
            WHERE reservation_key = '0031-submit-unknown'
            """
        ),
        "0031 must reject a direct refund from submit_unknown",
        "refunded task billing intent is incomplete",
    )
    assert_task_billing_state(
        conn,
        "0031-submit-unknown",
        "reserved",
        "submit_unknown",
        "rejected submit_unknown refund must leave the intent unchanged",
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        unknown_accounting,
        "rejected submit_unknown refund must leave accounting unchanged",
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'rejected', updated_at = 1204
        WHERE reservation_key = '0031-submit-unknown'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', refunded_at = 1205, updated_at = 1205
        WHERE reservation_key = '0031-submit-unknown'
        """
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        baseline,
        "rejected submit may refund after the provider outcome is known",
    )

    insert_task_billing_intent(
        conn,
        "0031-attached-refund",
        user_id,
        token_id,
        channel_id,
        quota=60,
        created_at=1300,
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE task_billing_intents
            SET submit_state = 'submitted', updated_at = 1301
            WHERE reservation_key = '0031-attached-refund'
            """
        ),
        "0031 must reject prepared to submitted without submitting",
        "invalid task billing intent submit transition",
    )
    assert_task_billing_state(
        conn,
        "0031-attached-refund",
        "reserved",
        "prepared",
        "invalid submit transition must leave the intent unchanged",
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitting', submit_attempt_count = 1, updated_at = 1302
        WHERE reservation_key = '0031-attached-refund'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitted',
            provider_task_id = 'provider-task-refund',
            updated_at = 1303
        WHERE reservation_key = '0031-attached-refund'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'attached', request_accounted = 1,
            attached_at = 1304, updated_at = 1304
        WHERE reservation_key = '0031-attached-refund'
        """
    )
    attached_accounting = (940, 160, 8, 740, 260, 360)
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        attached_accounting,
        "submitted attach must account the request once",
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'attached', updated_at = 1305
        WHERE reservation_key = '0031-attached-refund'
        """
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        attached_accounting,
        "repeated attached status must not double-account the request",
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', refunded_at = 1306, updated_at = 1306
        WHERE reservation_key = '0031-attached-refund'
        """
    )
    refunded_accounting = (1000, 160, 8, 800, 200, 360)
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        refunded_accounting,
        "terminal refund must restore the reserve exactly once",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE task_billing_intents
            SET status = 'refunded', refunded_at = 1307, updated_at = 1307
            WHERE reservation_key = '0031-attached-refund'
            """
        ),
        "0031 must reject a second terminal refund",
        "refunded task billing intent is incomplete",
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        refunded_accounting,
        "rejected second refund must not change accounting",
    )

    immutable_mutations = (
        ("reservation_key", "reservation_key = '0031-changed-key'"),
        ("task_kind", "task_kind = 'midjourney'"),
        ("public_task_id", "public_task_id = '0031-changed-public-task'"),
        ("user_id", "user_id = user_id + 1"),
        ("token_id", "token_id = 0"),
        ("channel_id", "channel_id = channel_id + 1"),
        ("quota", "quota = quota + 1"),
        ("funding_source", "funding_source = 'subscription'"),
        ("subscription_id", "subscription_id = 1"),
        ("billing_contract_json", "billing_contract_json = '{\"changed\":true}'"),
        ("billing_contract_sha256", f"billing_contract_sha256 = '{'b' * 64}'"),
        ("provider_kind", "provider_kind = 'changed-provider'"),
        (
            "provider_idempotency_key",
            "provider_idempotency_key = 'changed-idempotency-key'",
        ),
        ("created_at", "created_at = created_at + 1"),
    )
    for column, mutation in immutable_mutations:
        expect_integrity_error(
            lambda mutation=mutation: conn.execute(
                "UPDATE task_billing_intents SET "
                f"{mutation} WHERE reservation_key = '0031-attached-refund'"
            ),
            f"0031 must reject immutable contract mutation: {column}",
            "task billing intent contract is immutable",
        )

    insert_task_billing_intent(
        conn,
        "0031-settle",
        user_id,
        token_id,
        channel_id,
        quota=70,
        created_at=1400,
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitting', submit_attempt_count = 1, updated_at = 1401
        WHERE reservation_key = '0031-settle'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitted',
            provider_task_id = 'provider-task-settle',
            updated_at = 1402
        WHERE reservation_key = '0031-settle'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'attached', request_accounted = 1,
            attached_at = 1403, updated_at = 1403
        WHERE reservation_key = '0031-settle'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'settled', settled_at = 1404, updated_at = 1404
        WHERE reservation_key = '0031-settle'
        """
    )
    settled_row = conn.execute(
        """
        SELECT status, submit_state, request_accounted, settled_at
        FROM task_billing_intents
        WHERE reservation_key = '0031-settle'
        """
    ).fetchone()
    if settled_row != ("settled", "submitted", 1, 1404):
        raise SystemExit(f"0031 successful settle has unexpected state: {settled_row}")
    settled_accounting = (930, 230, 9, 730, 270, 430)
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        settled_accounting,
        "successful settle must retain the reserve and attached accounting",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE task_billing_intents
            SET status = 'attached', updated_at = 1405
            WHERE reservation_key = '0031-settle'
            """
        ),
        "0031 must reject settled to attached",
        "invalid task billing intent status transition",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE task_billing_intents
            SET submit_state = 'prepared', updated_at = 1405
            WHERE reservation_key = '0031-settle'
            """
        ),
        "0031 must reject submitted to prepared",
        "invalid task billing intent submit transition",
    )
    assert_task_billing_state(
        conn,
        "0031-settle",
        "settled",
        "submitted",
        "illegal terminal transitions must leave the intent unchanged",
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        settled_accounting,
        "illegal terminal transitions must leave accounting unchanged",
    )

    insert_task_billing_intent(
        conn,
        "0031-channel-delete-guard",
        user_id,
        token_id,
        channel_id,
        quota=0,
        created_at=1500,
    )
    expect_integrity_error(
        lambda: conn.execute("DELETE FROM channels WHERE id = ?", (channel_id,)),
        "0031 must keep channels with active task billing ownership",
        "channel has active task billing intent",
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', refunded_at = 1501, updated_at = 1501
        WHERE reservation_key = '0031-channel-delete-guard'
        """
    )

    insert_task_billing_intent(
        conn,
        "0031-soft-deleted-attach",
        user_id,
        token_id,
        channel_id,
        quota=20,
        created_at=1550,
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitting', submit_attempt_count = 1, updated_at = 1551
        WHERE reservation_key = '0031-soft-deleted-attach'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitted', provider_task_id = 'provider-soft-deleted',
            updated_at = 1552
        WHERE reservation_key = '0031-soft-deleted-attach'
        """
    )
    conn.execute("UPDATE users SET deleted_at = 1553 WHERE id = ?", (user_id,))
    conn.execute("UPDATE tokens SET deleted_at = 1553 WHERE id = ?", (token_id,))
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'attached', request_accounted = 1,
            attached_at = 1554, updated_at = 1554
        WHERE reservation_key = '0031-soft-deleted-attach'
        """
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', refunded_at = 1555, updated_at = 1555
        WHERE reservation_key = '0031-soft-deleted-attach'
        """
    )
    soft_deleted_attach_accounting = (930, 250, 10, 730, 270, 450)
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        soft_deleted_attach_accounting,
        "soft-deleted owners must not block accepted task attachment or refund",
    )
    conn.execute("UPDATE users SET deleted_at = NULL WHERE id = ?", (user_id,))
    conn.execute("UPDATE tokens SET deleted_at = NULL WHERE id = ?", (token_id,))

    insert_task_billing_intent(
        conn,
        "0031-soft-deleted-refund",
        user_id,
        token_id,
        channel_id,
        quota=20,
        created_at=1600,
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET submit_state = 'submitting', submit_attempt_count = 1, updated_at = 1601
        WHERE reservation_key = '0031-soft-deleted-refund'
        """
    )
    conn.execute("UPDATE users SET deleted_at = 1602 WHERE id = ?", (user_id,))
    conn.execute("UPDATE tokens SET deleted_at = 1602 WHERE id = ?", (token_id,))
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', submit_state = 'rejected',
            refunded_at = 1603, updated_at = 1603
        WHERE reservation_key = '0031-soft-deleted-refund'
        """
    )
    assert_task_billing_accounting(
        conn,
        user_id,
        token_id,
        channel_id,
        soft_deleted_attach_accounting,
        "soft-deleted users and tokens must still receive owned refunds",
    )
    conn.execute("UPDATE users SET deleted_at = NULL WHERE id = ?", (user_id,))
    conn.execute("UPDATE tokens SET deleted_at = NULL WHERE id = ?", (token_id,))

    conn.execute("DELETE FROM task_billing_intents WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
    conn.execute("DELETE FROM channels WHERE id = ?", (channel_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def insert_task_billing_intent(
    conn: sqlite3.Connection,
    reservation_key: str,
    user_id: int,
    token_id: int,
    channel_id: int,
    quota: int,
    created_at: int,
) -> None:
    client_operation_key_sha256 = hashlib.sha256(
        f"client-operation:{reservation_key}".encode()
    ).hexdigest()
    client_request_sha256 = hashlib.sha256(
        f"client-request:{reservation_key}".encode()
    ).hexdigest()
    conn.execute(
        """
        INSERT INTO task_billing_intents (
          reservation_key, task_kind, public_task_id, user_id, token_id,
          channel_id, quota, billing_contract_json, billing_contract_sha256,
          attach_contract_json, attach_contract_sha256,
          provider_kind, provider_idempotency_key,
          client_operation_key_sha256, client_request_sha256,
          submit_deadline_at, lease_expires_at, created_at, updated_at
        ) VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sqlite-provider', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            reservation_key,
            f"public:{reservation_key}",
            user_id,
            token_id,
            channel_id,
            quota,
            '{"funding_source":"wallet"}',
            "a" * 64,
            '{"contract_version":"task-attach-v1","task_kind":"task"}',
            "b" * 64,
            f"provider:{reservation_key}",
            client_operation_key_sha256,
            client_request_sha256,
            created_at + 90,
            created_at + 300,
            created_at,
            created_at,
        ),
    )


def verify_task_submit_operation(conn: sqlite3.Connection) -> None:
    for trigger in (
        "task_billing_intent_submit_operation_insert_guard",
        "task_billing_intent_submit_operation_immutable_guard",
    ):
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0039 task submit operation trigger missing: {trigger}")

    user_id = 380038
    token_id = 380038
    channel_id = 380038
    conn.execute(
        "INSERT INTO users (id, username, password, quota, aff_code, created_at) "
        "VALUES (?, 'sqlite-0039-user', 'not-used', 1000, 'sqlite-0039', 1)",
        (user_id,),
    )
    conn.execute(
        "INSERT INTO tokens (id, user_id, \"key\", remain_quota, used_quota) "
        "VALUES (?, ?, 'sqlite-0039-token', 1000, 0)",
        (token_id, user_id),
    )
    conn.execute(
        "INSERT INTO channels (id, key, name) "
        "VALUES (?, 'sqlite-0039-channel-key', 'sqlite-0039-channel')",
        (channel_id,),
    )
    insert_task_billing_intent(
        conn,
        "0039-operation",
        user_id,
        token_id,
        channel_id,
        quota=10,
        created_at=3_900,
    )
    deadline = conn.execute(
        "SELECT submit_deadline_at FROM task_billing_intents "
        "WHERE reservation_key = '0039-operation'"
    ).fetchone()[0]
    if deadline != 3_990:
        raise SystemExit(f"0039 task submit deadline was not persisted: {deadline}")

    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE task_billing_intents SET submit_deadline_at = 3991 "
            "WHERE reservation_key = '0039-operation'"
        ),
        "0039 submit deadline must be immutable",
        "task submit operation identity is immutable",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            INSERT INTO task_billing_intents (
              reservation_key, task_kind, public_task_id, user_id, token_id,
              channel_id, quota, billing_contract_json, billing_contract_sha256,
              attach_contract_json, attach_contract_sha256,
              provider_kind, provider_idempotency_key,
              client_operation_key_sha256, client_request_sha256,
              submit_deadline_at, lease_expires_at, created_at, updated_at
            )
            SELECT '0039-operation-duplicate', task_kind,
                   'public:0039-operation-duplicate', user_id, token_id,
                   channel_id, quota, billing_contract_json,
                   billing_contract_sha256, attach_contract_json,
                   attach_contract_sha256, provider_kind,
                   provider_idempotency_key, lower(hex(randomblob(32))),
                   client_request_sha256, submit_deadline_at,
                   lease_expires_at, created_at, updated_at
            FROM task_billing_intents
            WHERE reservation_key = '0039-operation'
            """
        ),
        "0038 provider operation identity must be unique",
        "UNIQUE constraint failed",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            INSERT INTO task_billing_intents (
              reservation_key, task_kind, public_task_id, user_id, token_id,
              channel_id, quota, billing_contract_json, billing_contract_sha256,
              attach_contract_json, attach_contract_sha256,
              provider_kind, provider_idempotency_key,
              client_operation_key_sha256, client_request_sha256,
              submit_deadline_at, lease_expires_at, created_at, updated_at
            )
            SELECT '0039-client-operation-duplicate', task_kind,
                   'public:0039-client-operation-duplicate', user_id, token_id,
                   channel_id, quota, billing_contract_json,
                   billing_contract_sha256, attach_contract_json,
                   attach_contract_sha256, provider_kind,
                   'provider:0039-client-operation-duplicate',
                   client_operation_key_sha256, client_request_sha256,
                   submit_deadline_at, lease_expires_at, created_at, updated_at
            FROM task_billing_intents
            WHERE reservation_key = '0039-operation'
            """
        ),
        "0038 client operation identity must be unique per token and task kind",
        "UNIQUE constraint failed",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            INSERT INTO task_billing_intents (
              reservation_key, task_kind, public_task_id, user_id, token_id,
              channel_id, quota, billing_contract_json, billing_contract_sha256,
              attach_contract_json, attach_contract_sha256,
              provider_kind, provider_idempotency_key,
              client_operation_key_sha256, client_request_sha256,
              submit_deadline_at, lease_expires_at, created_at, updated_at
            ) VALUES (
              '0039-invalid-deadline', 'task', 'public:0039-invalid-deadline',
              ?, ?, ?, 1, '{"funding_source":"wallet"}', ?,
              '{"contract_version":"task-attach-v1","task_kind":"task"}', ?,
              'sqlite-provider', 'provider:0039-invalid-deadline', ?, ?, 4121,
              4300, 4000, 4000
            )
            """,
            (
                user_id,
                token_id,
                channel_id,
                "a" * 64,
                "b" * 64,
                hashlib.sha256(b"invalid-deadline-operation").hexdigest(),
                hashlib.sha256(b"invalid-deadline-request").hexdigest(),
            ),
        ),
        "0039 submit deadline must stay inside the 5..120 second contract",
        "task submit operation contract is invalid",
    )

    plan = " ".join(
        row[3]
        for row in conn.execute(
            "EXPLAIN QUERY PLAN SELECT reservation_key "
            "FROM task_billing_intents "
            "INDEXED BY idx_task_billing_intents_submit_deadline "
            "WHERE status = 'reserved' "
            "AND submit_state IN ('prepared', 'submitting', 'rejected') "
            "AND submit_deadline_at < 5000 "
            "ORDER BY submit_state, submit_deadline_at, reservation_key"
        ).fetchall()
    )
    if "idx_task_billing_intents_submit_deadline" not in plan:
        raise SystemExit(f"0038 submit deadline query missed partial index: {plan}")

    conn.execute("DELETE FROM task_billing_intents WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
    conn.execute("DELETE FROM channels WHERE id = ?", (channel_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def verify_task_submit_reconciliation(conn: sqlite3.Connection) -> None:
    for trigger in (
        "task_billing_intent_reconciliation_guard",
        "task_billing_reconciliation_event_update_guard",
        "task_billing_reconciliation_event_delete_guard",
    ):
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0032 task reconciliation trigger missing: {trigger}")

    user_id = 330033
    token_id = 330033
    channel_id = 330033
    conn.execute(
        "INSERT INTO users (id, username, password, quota, created_at) "
        "VALUES (?, 'sqlite-0033-user', 'not-used', 1000, 1)",
        (user_id,),
    )
    conn.execute(
        "INSERT INTO tokens (id, user_id, \"key\", remain_quota, used_quota) "
        "VALUES (?, ?, 'sqlite-0033-token', 1000, 0)",
        (token_id, user_id),
    )
    conn.execute(
        "INSERT INTO channels (id, key, name) "
        "VALUES (?, 'sqlite-0033-channel-key', 'sqlite-0033-channel')",
        (channel_id,),
    )
    insert_task_billing_intent(
        conn,
        "0033-reconcile-refund",
        user_id,
        token_id,
        channel_id,
        quota=75,
        created_at=2000,
    )
    conn.execute(
        "UPDATE task_billing_intents SET submit_state = 'submitting', updated_at = 2001 "
        "WHERE reservation_key = '0033-reconcile-refund'"
    )
    reconciliation_id = "c" * 64
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'recovery_required', submit_state = 'submit_unknown',
            reconciliation_id = ?, reconciliation_revision = 1,
            recovery_required_at = 2002, updated_at = 2002
        WHERE reservation_key = '0033-reconcile-refund'
        """,
        (reconciliation_id,),
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE task_billing_intents SET status = 'refunded', "
            "submit_state = 'rejected', refunded_at = 2003, updated_at = 2003 "
            "WHERE reservation_key = '0033-reconcile-refund'"
        ),
        "0032 must reject reconciliation without an immutable event",
        "invalid task billing reconciliation transition",
    )
    resolution_key = "d" * 64
    evidence_sha256 = "e" * 64
    conn.execute(
        """
        INSERT INTO task_billing_reconciliation_events (
          resolution_key, reconciliation_id, reservation_key,
          reconciliation_revision, action, reason, provider_task_id,
          evidence_reference, evidence_sha256, preview_token,
          decision_sha256, operator_id, created_at
        ) VALUES (?, ?, '0033-reconcile-refund', 1, 'refund',
                  'provider_confirms_not_accepted', '', 'ticket:0033', ?, ?, ?, 1, 2004)
        """,
        (resolution_key, reconciliation_id, evidence_sha256, "f" * 64, "a" * 64),
    )
    conn.execute(
        """
        UPDATE task_billing_intents
        SET status = 'refunded', submit_state = 'rejected', refunded_at = 2004,
            updated_at = 2004, reconciliation_revision = 2,
            reconciliation_resolution = 'refunded',
            reconciliation_resolution_key = ?, reconciliation_resolved_at = 2004,
            reconciliation_operator_id = 1,
            reconciliation_evidence_sha256 = ?,
            reconciliation_reason = 'provider_confirms_not_accepted'
        WHERE reservation_key = '0033-reconcile-refund'
        """,
        (resolution_key, evidence_sha256),
    )
    accounting = conn.execute(
        "SELECT u.quota, t.remain_quota, t.used_quota "
        "FROM users u JOIN tokens t ON t.user_id = u.id "
        "WHERE u.id = ? AND t.id = ?",
        (user_id, token_id),
    ).fetchone()
    if accounting != (1000, 1000, 0):
        raise SystemExit(f"0032 reconciliation refund accounting mismatch: {accounting}")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE task_billing_reconciliation_events SET reason = 'changed' "
            "WHERE resolution_key = ?",
            (resolution_key,),
        ),
        "0032 reconciliation event must be update-immutable",
        "task billing reconciliation event is immutable",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "DELETE FROM task_billing_reconciliation_events WHERE resolution_key = ?",
            (resolution_key,),
        ),
        "0032 reconciliation event must be delete-immutable",
        "task billing reconciliation event is immutable",
    )

def verify_task_poll_lease(conn: sqlite3.Connection) -> None:
    for trigger in (
        "task_poll_lease_shape_guard",
        "midjourney_poll_lease_shape_guard",
        "task_poll_write_revision_guard",
        "midjourney_poll_write_revision_guard",
    ):
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0035 task poll lease trigger missing: {trigger}")

    control = conn.execute(
        "SELECT id, contract_version, authority_enabled, enforcement_enabled, updated_at "
        "FROM task_poll_lease_control WHERE id = 1"
    ).fetchone()
    if control != (1, 1, 0, 0, 0):
        raise SystemExit(f"0034 task poll control row must default inert: {control}")

    index_contracts = {
        "idx_tasks_poll_lease_due": (
            "on tasks(poll_lease_expires_at, id)",
            "where status not in ('success', 'failure') and upstream_task_id != ''",
        ),
        "idx_midjourneys_poll_lease_due": (
            "on midjourneys(poll_lease_expires_at, id)",
            "where status not in ('success', 'failure') and mj_id != ''",
        ),
    }
    for index, fragments in index_contracts.items():
        sql = sqlite_object_sql(conn, "index", index)
        normalized = " ".join(sql.lower().split()) if sql else ""
        if not sql or any(fragment not in normalized for fragment in fragments):
            raise SystemExit(f"0034 task poll lease index contract invalid: {index}")

    conn.execute(
        """
        INSERT INTO tasks (
          id, task_id, upstream_task_id, platform, status, progress, submit_time
        ) VALUES (350001, 'poll-lease-task', 'provider-task', 'sora',
                  'IN_PROGRESS', '10%', 100)
        """
    )
    legacy_write = conn.execute(
        "UPDATE tasks SET progress = '11%' WHERE id = 350001"
    ).rowcount
    if legacy_write != 1:
        raise SystemExit("0034 default-off enforcement blocked a legacy task writer")
    first_claim = conn.execute(
        """
        UPDATE tasks
        SET poll_owner = 'cron:a', poll_generation = poll_generation + 1,
            poll_lease_expires_at = 120
        WHERE id = 350001 AND poll_generation = 0
          AND poll_lease_expires_at <= 10
        """
    ).rowcount
    second_claim = conn.execute(
        """
        UPDATE tasks
        SET poll_owner = 'runner:b', poll_generation = poll_generation + 1,
            poll_lease_expires_at = 120
        WHERE id = 350001 AND poll_generation = 0
          AND poll_lease_expires_at <= 10
        """
    ).rowcount
    if (first_claim, second_claim) != (1, 0):
        raise SystemExit(
            f"0034 concurrent task poll claim mismatch: {(first_claim, second_claim)}"
        )

    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE tasks SET poll_lease_expires_at = 121 "
            "WHERE id = 350001 AND poll_owner = 'cron:a' AND poll_generation = 1"
        ),
        "0035 must reject extending a task lease without a new generation",
        "invalid task poll lease transition",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE tasks SET poll_generation = 0 WHERE id = 350001"
        ),
        "0035 must reject decreasing the task poll generation",
        "invalid task poll lease transition",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE tasks SET poll_owner = '' WHERE id = 350001"
        ),
        "0035 must reject clearing a task owner without clearing its lease",
        "invalid task poll lease transition",
    )

    expired_apply = conn.execute(
        """
        UPDATE tasks
        SET progress = '15%', poll_owner = '', poll_lease_expires_at = 0,
            poll_applied_generation = 1,
            poll_write_revision = poll_write_revision + 1
        WHERE id = 350001 AND poll_owner = 'cron:a' AND poll_generation = 1
          AND poll_lease_expires_at > 130
        """
    ).rowcount
    first_apply = conn.execute(
        """
        UPDATE tasks
        SET progress = '20%', poll_owner = '', poll_lease_expires_at = 0,
            poll_applied_generation = 1,
            poll_write_revision = poll_write_revision + 1
        WHERE id = 350001 AND poll_owner = 'cron:a' AND poll_generation = 1
          AND poll_lease_expires_at > 20
        """
    ).rowcount
    takeover = conn.execute(
        """
        UPDATE tasks
        SET poll_owner = 'runner:b', poll_generation = poll_generation + 1,
            poll_lease_expires_at = 240
        WHERE id = 350001 AND poll_generation = 1
          AND poll_lease_expires_at <= 20
        """
    ).rowcount
    stale_apply = conn.execute(
        """
        UPDATE tasks
        SET progress = '15%', poll_owner = '', poll_lease_expires_at = 0,
            poll_applied_generation = 1,
            poll_write_revision = poll_write_revision + 1
        WHERE id = 350001 AND poll_owner = 'cron:a' AND poll_generation = 1
        """
    ).rowcount
    if (expired_apply, first_apply, takeover, stale_apply) != (0, 1, 1, 0):
        raise SystemExit(
            "0034 task poll generation fencing failed: "
            f"{(expired_apply, first_apply, takeover, stale_apply)}"
        )

    conn.execute(
        "UPDATE task_poll_lease_control SET authority_enabled = 1, "
        "enforcement_enabled = 1, updated_at = 30 "
        "WHERE id = 1"
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE tasks SET status = 'SUCCESS', progress = '100%' "
            "WHERE id = 350001"
        ),
        "0035 must reject a task lifecycle write without a revision advance",
        "task poll write revision required",
    )
    fenced_apply = conn.execute(
        """
        UPDATE tasks
        SET status = 'SUCCESS', progress = '100%', finish_time = 40,
            poll_owner = '', poll_lease_expires_at = 0,
            poll_applied_generation = 2,
            poll_write_revision = poll_write_revision + 1
        WHERE id = 350001 AND poll_owner = 'runner:b' AND poll_generation = 2
        """
    ).rowcount
    final = conn.execute(
        """
        SELECT status, progress, poll_generation, poll_applied_generation,
               poll_write_revision, poll_owner, poll_lease_expires_at
        FROM tasks WHERE id = 350001
        """
    ).fetchone()
    if fenced_apply != 1 or final != ("SUCCESS", "100%", 2, 2, 2, "", 0):
        raise SystemExit(f"0035 fenced task apply mismatch: {final}")

    conn.execute(
        """
        INSERT INTO midjourneys (
          id, mj_id, status, progress, submit_time
        ) VALUES (350002, 'poll-lease-mj', 'IN_PROGRESS', '5%', 100)
        """
    )
    conn.execute(
        """
        UPDATE midjourneys
        SET poll_owner = 'cron:mj', poll_generation = 1,
            poll_lease_expires_at = 120
        WHERE id = 350002
        """
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE midjourneys SET poll_lease_expires_at = 121 "
            "WHERE id = 350002 AND poll_owner = 'cron:mj' AND poll_generation = 1"
        ),
        "0035 must reject extending a Midjourney lease without a new generation",
        "invalid midjourney poll lease transition",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE midjourneys SET poll_applied_generation = 2 WHERE id = 350002"
        ),
        "0035 must reject a Midjourney applied generation ahead of its claim",
        "invalid midjourney poll lease transition",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE midjourneys SET progress = '9%' WHERE id = 350002"
        ),
        "0035 must reject a Midjourney lifecycle write without a revision advance",
        "midjourney poll write revision required",
    )
    mj_apply = conn.execute(
        """
        UPDATE midjourneys
        SET progress = '10%', poll_owner = '', poll_lease_expires_at = 0,
            poll_applied_generation = 1,
            poll_write_revision = poll_write_revision + 1
        WHERE id = 350002 AND poll_owner = 'cron:mj' AND poll_generation = 1
        """
    ).rowcount
    if mj_apply != 1:
        raise SystemExit("0035 fenced Midjourney apply did not win")

    conn.execute(
        "UPDATE task_poll_lease_control SET authority_enabled = 0, "
        "enforcement_enabled = 0, updated_at = 50 "
        "WHERE id = 1"
    )
    rollback_write = conn.execute(
        "UPDATE midjourneys SET progress = '11%' WHERE id = 350002"
    ).rowcount
    if rollback_write != 1:
        raise SystemExit("0035 rollback switch did not restore legacy writer compatibility")


def verify_task_poll_schedule(conn: sqlite3.Connection) -> None:
    expected_families = [
        "midjourney",
        "midjourney_timeout",
        "suno",
        "task_timeout",
        "video",
    ]
    cursors = conn.execute(
        "SELECT family, last_row_id, round_high_watermark, scan_generation, updated_at "
        "FROM task_poll_family_cursors ORDER BY family"
    ).fetchall()
    expected_cursors = [(family, 0, 0, 0, 0) for family in expected_families]
    if cursors != expected_cursors:
        raise SystemExit(f"0036 family cursors must default inert: {cursors}")

    index_contracts = {
        "idx_tasks_poll_schedule_due": (
            "on tasks(next_poll_at, id)",
            "status not in ('success', 'failure')",
            "upstream_task_id != ''",
            "poll_quarantined_at = 0",
        ),
        "idx_midjourneys_poll_schedule_due": (
            "on midjourneys(next_poll_at, id)",
            "status not in ('success', 'failure')",
            "mj_id != ''",
            "poll_quarantined_at = 0",
        ),
    }
    for index, fragments in index_contracts.items():
        sql = sqlite_object_sql(conn, "index", index)
        normalized = " ".join(sql.lower().split()) if sql else ""
        if not sql or any(fragment not in normalized for fragment in fragments):
            raise SystemExit(f"0036 task poll schedule index contract invalid: {index}")

    conn.execute(
        "INSERT INTO tasks "
        "(id, task_id, upstream_task_id, platform, status, progress, submit_time) "
        "VALUES (360001, '0036-task-video', 'provider-video', 'sora', "
        "'IN_PROGRESS', '1%', 1)"
    )
    conn.execute(
        "INSERT INTO tasks "
        "(id, task_id, upstream_task_id, platform, status, progress, submit_time) "
        "VALUES (360002, '0036-task-suno', 'provider-suno', 'suno', "
        "'IN_PROGRESS', '1%', 1)"
    )
    conn.execute(
        "INSERT INTO midjourneys (id, mj_id, status, progress, submit_time) "
        "VALUES (360003, '0036-mj', 'IN_PROGRESS', '1%', 1)"
    )
    schedule_columns = (
        "next_poll_at, poll_attempt_count, poll_consecutive_failures, "
        "poll_last_attempt_at, poll_last_error_code, poll_quarantined_at, "
        "poll_quarantine_reason"
    )
    for table, row_id in (("tasks", 360001), ("midjourneys", 360003)):
        defaults = conn.execute(
            f"SELECT {schedule_columns} FROM {table} WHERE id = ?", (row_id,)
        ).fetchone()
        if defaults != (0, 0, 0, 0, "", 0, ""):
            raise SystemExit(f"0036 {table} schedule defaults are not inert: {defaults}")

    due = conn.execute(
        "SELECT id FROM tasks WHERE status NOT IN ('SUCCESS', 'FAILURE') "
        "AND upstream_task_id != '' AND next_poll_at <= 100 "
        "AND poll_quarantined_at = 0 AND poll_lease_expires_at <= 100 "
        "ORDER BY id"
    ).fetchall()
    if (360001,) not in due or (360002,) not in due:
        raise SystemExit(f"0036 due query omitted default-due tasks: {due}")
    conn.execute(
        "UPDATE tasks SET next_poll_at = 200 WHERE id = 360001"
    )
    conn.execute(
        "UPDATE tasks SET poll_quarantined_at = 90, "
        "poll_quarantine_reason = 'provider_poll_failed' WHERE id = 360002"
    )
    blocked = conn.execute(
        "SELECT id FROM tasks WHERE id IN (360001, 360002) "
        "AND status NOT IN ('SUCCESS', 'FAILURE') AND next_poll_at <= 100 "
        "AND poll_quarantined_at = 0"
    ).fetchall()
    if blocked:
        raise SystemExit(f"0036 due/quarantine filter admitted blocked rows: {blocked}")

    reset = conn.execute(
        "UPDATE task_poll_family_cursors SET last_row_id = 0, "
        "round_high_watermark = 360001, scan_generation = scan_generation + 1, "
        "updated_at = 100 WHERE family = 'video' AND last_row_id = 0 "
        "AND round_high_watermark = 0 AND scan_generation = 0"
    ).rowcount
    advanced = conn.execute(
        "UPDATE task_poll_family_cursors SET last_row_id = 360001, updated_at = 101 "
        "WHERE family = 'video' AND scan_generation = 1 "
        "AND round_high_watermark = 360001 AND last_row_id < 360001"
    ).rowcount
    stale = conn.execute(
        "UPDATE task_poll_family_cursors SET last_row_id = 1 "
        "WHERE family = 'video' AND scan_generation = 0"
    ).rowcount
    if (reset, advanced, stale) != (1, 1, 0):
        raise SystemExit(
            f"0036 finite-round cursor CAS mismatch: {(reset, advanced, stale)}"
        )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE task_poll_family_cursors SET last_row_id = 360002 "
            "WHERE family = 'video'"
        ),
        "0036 cursor must reject progress beyond its high-watermark",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "INSERT INTO task_poll_family_cursors (family) VALUES ('unknown')"
        ),
        "0036 cursor must reject an unknown poll family",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE midjourneys SET poll_last_error_code = ? WHERE id = 360003",
            ("x" * 65,),
        ),
        "0036 schedule error codes must remain bounded",
    )


def verify_task_poll_recovery(conn: sqlite3.Connection) -> None:
    required_objects = {
        "table": ("task_poll_recovery_events",),
        "index": (
            "idx_task_poll_recovery_events_entity",
            "idx_task_poll_recovery_events_revision",
            "idx_tasks_poll_quarantine_queue",
            "idx_midjourneys_poll_quarantine_queue",
        ),
        "trigger": (
            "task_poll_recovery_event_update_guard",
            "task_poll_recovery_event_delete_guard",
            "task_poll_recovery_task_guard",
            "task_poll_recovery_midjourney_guard",
            "task_poll_recovery_task_apply",
            "task_poll_recovery_midjourney_apply",
        ),
    }
    for object_type, names in required_objects.items():
        for name in names:
            if sqlite_object_sql(conn, object_type, name) is None:
                raise SystemExit(f"0037 task poll recovery object missing: {name}")

    before = conn.execute(
        "SELECT status, progress, quota, poll_generation, poll_write_revision, "
        "poll_quarantined_at, poll_quarantine_reason "
        "FROM tasks WHERE id = 360002"
    ).fetchone()
    if before != (
        "IN_PROGRESS",
        "1%",
        0,
        0,
        0,
        90,
        "provider_poll_failed",
    ):
        raise SystemExit(f"0037 task recovery fixture is invalid: {before}")

    task_event = (
        "a" * 64,
        "task",
        360002,
        "0036-task-suno",
        0,
        0,
        90,
        301,
        "provider_poll_failed",
        "requeue",
        "provider_incident_resolved",
        "incident:INC-360002",
        "b" * 64,
        "c" * 64,
        "d" * 64,
        1,
        200,
    )
    insert_sql = (
        "INSERT INTO task_poll_recovery_events ("
        "resolution_key, entity_kind, entity_id, public_task_id, "
        "expected_poll_generation, expected_poll_write_revision, "
        "expected_quarantined_at, expected_hard_timeout_at, "
        "expected_quarantine_reason, action, reason, "
        "evidence_reference, evidence_sha256, preview_token, decision_sha256, "
        "operator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    conn.execute(insert_sql, task_event)
    recovered = conn.execute(
        "SELECT status, progress, quota, next_poll_at, poll_consecutive_failures, "
        "poll_last_error_code, poll_quarantined_at, poll_quarantine_reason, "
        "poll_write_revision FROM tasks WHERE id = 360002"
    ).fetchone()
    if recovered != ("IN_PROGRESS", "1%", 0, 200, 0, "", 0, "", 1):
        raise SystemExit(f"0037 task recovery mutation is invalid: {recovered}")

    expect_integrity_error(
        lambda: conn.execute(insert_sql, task_event),
        "0037 duplicate resolution must not requeue twice",
    )
    if conn.execute(
        "SELECT poll_write_revision FROM tasks WHERE id = 360002"
    ).fetchone() != (1,):
        raise SystemExit("0037 duplicate recovery changed task revision")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE task_poll_recovery_events SET reason = 'operator_retry_approved' "
            "WHERE resolution_key = ?",
            ("a" * 64,),
        ),
        "0037 recovery events must reject updates",
        "task poll recovery events are immutable",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "DELETE FROM task_poll_recovery_events WHERE resolution_key = ?",
            ("a" * 64,),
        ),
        "0037 recovery events must reject deletes",
        "task poll recovery events are immutable",
    )

    conn.execute(
        "UPDATE midjourneys SET poll_write_revision = 4, poll_quarantined_at = 100, "
        "poll_quarantine_reason = 'provider_unsupported' WHERE id = 360003"
    )
    stale_midjourney_event = (
        "e" * 64,
        "midjourney",
        360003,
        "0036-mj",
        0,
        3,
        100,
        3601,
        "provider_unsupported",
        "requeue",
        "provider_configuration_corrected",
        "change:CFG-360003",
        "f" * 64,
        "1" * 64,
        "2" * 64,
        1,
        201,
    )
    expect_integrity_error(
        lambda: conn.execute(insert_sql, stale_midjourney_event),
        "0037 stale Midjourney preview must fail closed",
        "midjourney poll recovery preview is stale",
    )
    valid_midjourney_event = list(stale_midjourney_event)
    valid_midjourney_event[0] = "3" * 64
    valid_midjourney_event[5] = 4
    conn.execute(insert_sql, tuple(valid_midjourney_event))
    recovered_midjourney = conn.execute(
        "SELECT status, progress, next_poll_at, poll_consecutive_failures, "
        "poll_last_error_code, poll_quarantined_at, poll_quarantine_reason, "
        "poll_write_revision FROM midjourneys WHERE id = 360003"
    ).fetchone()
    if recovered_midjourney != ("IN_PROGRESS", "1%", 201, 0, "", 0, "", 5):
        raise SystemExit(
            f"0037 Midjourney recovery mutation is invalid: {recovered_midjourney}"
        )

    if conn.execute("SELECT COUNT(*) FROM task_poll_recovery_events").fetchone() != (2,):
        raise SystemExit("0037 recovery event count is invalid")

    expect_integrity_error(
        lambda: conn.execute(insert_sql, ("A" * 64,) + task_event[1:]),
        "0037 recovery digests must be lowercase hex",
    )
    conn.execute(
        "INSERT INTO tasks "
        "(id, task_id, upstream_task_id, platform, status, progress, submit_time, "
        "poll_quarantined_at, poll_quarantine_reason) VALUES "
        "(370039, '0037-expired-task', 'provider-expired', 'sora', "
        "'IN_PROGRESS', '1%', 100, 150, 'provider_poll_failed')"
    )
    expired_event = list(task_event)
    expired_event[0] = "4" * 64
    expired_event[2] = 370039
    expired_event[3] = "0037-expired-task"
    expired_event[6] = 150
    expired_event[7] = 160
    expect_integrity_error(
        lambda: conn.execute(insert_sql, tuple(expired_event)),
        "0037 recovery must reject an expired hard-timeout boundary",
        "task poll recovery preview is stale",
    )
    task_plan = " ".join(
        str(column)
        for row in conn.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM tasks "
            "WHERE poll_quarantined_at > 0 "
            "AND status NOT IN ('SUCCESS', 'FAILURE') "
            "AND upstream_task_id != '' ORDER BY poll_quarantined_at, id"
        ).fetchall()
        for column in row
    )
    midjourney_plan = " ".join(
        str(column)
        for row in conn.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM midjourneys "
            "WHERE poll_quarantined_at > 0 "
            "AND status NOT IN ('SUCCESS', 'FAILURE') "
            "AND mj_id != '' ORDER BY poll_quarantined_at, id"
        ).fetchall()
        for column in row
    )
    if "idx_tasks_poll_quarantine_queue" not in task_plan:
        raise SystemExit(f"0037 task quarantine query missed partial index: {task_plan}")
    if "idx_midjourneys_poll_quarantine_queue" not in midjourney_plan:
        raise SystemExit(
            "0037 Midjourney quarantine query missed partial index: "
            f"{midjourney_plan}"
        )


def expect_integrity_error(
    action,
    failure_message: str,
    expected_error: str = "",
) -> None:
    try:
        action()
    except sqlite3.IntegrityError as error:
        if expected_error and expected_error not in str(error):
            raise SystemExit(
                f"{failure_message}: unexpected SQLite error: {error}"
            ) from error
        return
    raise SystemExit(failure_message)


def assert_task_billing_state(
    conn: sqlite3.Connection,
    reservation_key: str,
    expected_status: str,
    expected_submit_state: str,
    context: str,
) -> None:
    actual = conn.execute(
        """
        SELECT status, submit_state
        FROM task_billing_intents
        WHERE reservation_key = ?
        """,
        (reservation_key,),
    ).fetchone()
    expected = (expected_status, expected_submit_state)
    if actual != expected:
        raise SystemExit(f"0031 {context}: state={actual}, expected={expected}")


def assert_task_billing_accounting(
    conn: sqlite3.Connection,
    user_id: int,
    token_id: int,
    channel_id: int,
    expected: tuple[int, int, int, int, int, int],
    context: str,
) -> None:
    actual = conn.execute(
        """
        SELECT u.quota, u.used_quota, u.request_count,
               t.remain_quota, t.used_quota, c.used_quota
        FROM users AS u
        JOIN tokens AS t ON t.id = ? AND t.user_id = u.id
        JOIN channels AS c ON c.id = ?
        WHERE u.id = ?
        """,
        (token_id, channel_id, user_id),
    ).fetchone()
    if actual != expected:
        raise SystemExit(f"0031 {context}: accounting={actual}, expected={expected}")


def verify_realtime_lease_migration_guard(schema_paths: list[Path]) -> None:
    lease_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0020_realtime_billing_reservation_leases.sql"
        ),
        None,
    )
    if lease_path is None:
        raise SystemExit("0020 realtime reservation lease migration not found")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == lease_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute(
        """
        INSERT INTO realtime_billing_reservations (
          reservation_key, session, user_id, channel_id, model_name,
          snapshot_json, request_json
        ) VALUES ('guard-reservation', 'guard-session', 1, 1, 'guard-model', '{}', '{}')
        """
    )
    try:
        conn.executescript(lease_path.read_text(encoding="utf-8"))
    except sqlite3.IntegrityError:
        conn.execute(
            "UPDATE realtime_billing_reservations SET status = 'refunded' "
            "WHERE reservation_key = 'guard-reservation'"
        )
        conn.executescript(lease_path.read_text(encoding="utf-8"))
        if "lease_expires_at" not in table_columns(
            conn, "realtime_billing_reservations"
        ):
            raise SystemExit("0020 migration did not succeed after reconciliation")
        if table_exists(conn, "migration_0020_realtime_reservation_guard"):
            raise SystemExit("0020 migration guard table was not cleaned up")
        return
    raise SystemExit("0020 migration must reject unreconciled realtime reserved rows")


def verify_realtime_segment_migration_guard(schema_paths: list[Path]) -> None:
    segment_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0021_realtime_billing_bridge_segments.sql"
        ),
        None,
    )
    if segment_path is None:
        raise SystemExit("0021 realtime bridge-segment migration not found")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == segment_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute(
        """
        INSERT INTO realtime_billing_reservations (
          reservation_key, session, user_id, channel_id, model_name,
          snapshot_json, request_json
        ) VALUES ('segment-guard-reservation', 'segment-guard-session', 1, 1,
                  'guard-model', '{}', '{}')
        """
    )
    try:
        conn.executescript(segment_path.read_text(encoding="utf-8"))
    except sqlite3.IntegrityError:
        conn.execute(
            "UPDATE realtime_billing_reservations SET status = 'refunded' "
            "WHERE reservation_key = 'segment-guard-reservation'"
        )
        conn.executescript(segment_path.read_text(encoding="utf-8"))
        if "bridge_segment" not in table_columns(
            conn, "realtime_billing_reservations"
        ):
            raise SystemExit("0021 migration did not succeed after reconciliation")
        if table_exists(conn, "migration_0021_realtime_segment_guard"):
            raise SystemExit("0021 migration guard table was not cleaned up")
        segment_index = table_indexes(conn, "realtime_billing_reservations").get(
            "idx_realtime_billing_reservations_segment_status"
        )
        if segment_index is not False:
            raise SystemExit("0021 migration did not create the segment index")
        return
    raise SystemExit("0021 migration must reject unscoped realtime reserved rows")


def verify_relay_owner_migration_guard(schema_paths: list[Path]) -> None:
    owner_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0026_relay_billing_owner_generation.sql"
        ),
        None,
    )
    if owner_path is None:
        raise SystemExit("0026 relay owner-generation migration not found")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == owner_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute(
        """
        INSERT INTO relay_billing_reservations (
          reservation_key, user_id, model_name, lease_expires_at, created_at, updated_at
        ) VALUES ('owner-guard-reservation', 1, 'guard-model', 100, 1, 1)
        """
    )
    try:
        conn.executescript(owner_path.read_text(encoding="utf-8"))
    except sqlite3.IntegrityError:
        # SQLite preserves DDL that ran before an executescript constraint
        # failure, so clean the migration-local sentinel before retrying.
        conn.execute("DROP TABLE IF EXISTS migration_0026_relay_owner_guard")
        conn.execute(
            "UPDATE relay_billing_reservations "
            "SET status = 'refunded', finalization_reason = 'migration_drain', "
            "refunded_at = 2, updated_at = 2 "
            "WHERE reservation_key = 'owner-guard-reservation'"
        )
        conn.executescript(owner_path.read_text(encoding="utf-8"))
        columns = table_columns(conn, "relay_billing_reservations")
        if not {
            "owner_generation",
            "owner_deadline_at",
            "owner_lease_renewed_at",
        }.issubset(columns):
            raise SystemExit("0026 migration did not add relay owner fencing columns")
        if table_exists(conn, "migration_0026_relay_owner_guard"):
            raise SystemExit("0026 migration guard table was not cleaned up")
        migrated_generation = conn.execute(
            "SELECT owner_generation FROM relay_billing_reservations "
            "WHERE reservation_key = 'owner-guard-reservation'"
        ).fetchone()
        if migrated_generation != (2,):
            raise SystemExit("0026 migration did not normalize legacy terminal owner")
        return
    raise SystemExit("0026 migration must reject active relay reservations")


def verify_task_submit_reconciliation_rollout(schema_paths: list[Path]) -> None:
    expand_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0032_task_submit_reconciliation.sql"
        ),
        None,
    )
    enforce_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0033_task_submit_reconciliation_enforce.sql"
        ),
        None,
    )
    if expand_path is None or enforce_path is None:
        raise SystemExit("0032/0033 task reconciliation rollout migrations not found")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == expand_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))

    conn.execute(
        "INSERT INTO users (id, username, password, quota, created_at) "
        "VALUES (320032, 'sqlite-0032-user', 'not-used', 1000, 1)"
    )
    conn.execute(
        "INSERT INTO tokens (id, user_id, \"key\", remain_quota, used_quota) "
        "VALUES (320032, 320032, 'sqlite-0032-token', 1000, 0)"
    )
    conn.execute(
        "INSERT INTO channels (id, key, name) "
        "VALUES (320032, 'sqlite-0032-channel-key', 'sqlite-0032-channel')"
    )

    legacy_insert = """
        INSERT INTO task_billing_intents (
          reservation_key, task_kind, public_task_id, user_id, token_id,
          channel_id, quota, billing_contract_json, billing_contract_sha256,
          provider_kind, provider_idempotency_key, lease_expires_at,
          created_at, updated_at
        ) VALUES (?, 'task', ?, 320032, 320032, 320032, 10,
                  '{"funding_source":"wallet"}', ?, 'sqlite-provider', ?, 900, 1, 1)
    """

    def insert_legacy_intent(reservation_key: str) -> None:
        conn.execute(
            legacy_insert,
            (reservation_key, reservation_key, "a" * 64, f"provider:{reservation_key}"),
        )

    def quarantine(reservation_key: str) -> None:
        conn.execute(
            "UPDATE task_billing_intents SET submit_state = 'submitting', updated_at = 2 "
            "WHERE reservation_key = ?",
            (reservation_key,),
        )
        conn.execute(
            "UPDATE task_billing_intents "
            "SET status = 'recovery_required', submit_state = 'submit_unknown', "
            "recovery_required_at = 3, updated_at = 3 "
            "WHERE reservation_key = ?",
            (reservation_key,),
        )

    insert_legacy_intent("0032-preexisting-unknown")
    quarantine("0032-preexisting-unknown")
    conn.executescript(expand_path.read_text(encoding="utf-8"))
    preexisting = conn.execute(
        "SELECT length(reconciliation_id), reconciliation_revision, attach_contract_json "
        "FROM task_billing_intents WHERE reservation_key = '0032-preexisting-unknown'"
    ).fetchone()
    if preexisting != (64, 1, "{}"):
        raise SystemExit(f"0032 did not backfill legacy unknown row safely: {preexisting}")

    insert_legacy_intent("0032-late-old-writer")
    quarantine("0032-late-old-writer")
    late_writer = conn.execute(
        "SELECT length(reconciliation_id), reconciliation_revision, attach_contract_json "
        "FROM task_billing_intents WHERE reservation_key = '0032-late-old-writer'"
    ).fetchone()
    if late_writer != (64, 1, "{}"):
        raise SystemExit(f"0032 expand trigger did not protect old writer: {late_writer}")

    conn.executescript(enforce_path.read_text(encoding="utf-8"))
    expect_integrity_error(
        lambda: insert_legacy_intent("0033-blocked-old-writer"),
        "0033 must block a writer without a frozen attach contract",
        "task billing intent admission failed",
    )


def verify_task_submit_operation_rollout(schema_paths: list[Path]) -> None:
    expand_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0038_task_submit_operation_expand.sql"
        ),
        None,
    )
    enforce_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0039_task_submit_operation_enforce.sql"
        ),
        None,
    )
    if expand_path is None or enforce_path is None:
        raise SystemExit("0038/0039 task submit operation rollout migrations not found")
    if schema_paths.index(expand_path) + 1 != schema_paths.index(enforce_path):
        raise SystemExit("0038 expand must immediately precede 0039 enforcement")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == expand_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))

    user_id = 390039
    token_id = 390039
    channel_id = 390039
    conn.execute(
        "INSERT INTO users (id, username, password, quota, aff_code, created_at) "
        "VALUES (?, 'sqlite-0039-rollout-user', 'not-used', 1000, 'sqlite-0039-rollout', 1)",
        (user_id,),
    )
    conn.execute(
        "INSERT INTO tokens (id, user_id, \"key\", remain_quota, used_quota) "
        "VALUES (?, ?, 'sqlite-0039-rollout-token', 1000, 0)",
        (token_id, user_id),
    )
    conn.execute(
        "INSERT INTO channels (id, key, name) "
        "VALUES (?, 'sqlite-0039-rollout-channel-key', 'sqlite-0039-rollout-channel')",
        (channel_id,),
    )

    legacy_insert = """
        INSERT INTO task_billing_intents (
          reservation_key, task_kind, public_task_id, user_id, token_id,
          channel_id, quota, billing_contract_json, billing_contract_sha256,
          attach_contract_json, attach_contract_sha256,
          provider_kind, provider_idempotency_key, lease_expires_at,
          created_at, updated_at
        ) VALUES (?, 'task', ?, ?, ?, ?, 10,
                  '{"funding_source":"wallet"}', ?,
                  '{"contract_version":"task-attach-v1","task_kind":"task"}', ?,
                  'sqlite-provider', ?, ?, ?, ?)
    """

    def insert_legacy_intent(reservation_key: str, created_at: int) -> None:
        conn.execute(
            legacy_insert,
            (
                reservation_key,
                f"public:{reservation_key}",
                user_id,
                token_id,
                channel_id,
                "a" * 64,
                "b" * 64,
                f"provider:{reservation_key}",
                created_at + 900,
                created_at,
                created_at,
            ),
        )

    insert_legacy_intent("0038-preexisting", 3_800)
    conn.executescript(expand_path.read_text(encoding="utf-8"))
    preexisting_deadline = conn.execute(
        "SELECT submit_deadline_at FROM task_billing_intents "
        "WHERE reservation_key = '0038-preexisting'"
    ).fetchone()
    if preexisting_deadline != (0,):
        raise SystemExit(
            f"0038 expand changed an existing task deadline: {preexisting_deadline}"
        )

    insert_legacy_intent("0038-late-old-writer", 3_810)
    late_old_writer = conn.execute(
        "SELECT submit_deadline_at FROM task_billing_intents "
        "WHERE reservation_key = '0038-late-old-writer'"
    ).fetchone()
    if late_old_writer != (0,):
        raise SystemExit("0038 expand is not compatible with the old task writer")

    insert_task_billing_intent(
        conn,
        "0038-new-writer",
        user_id,
        token_id,
        channel_id,
        quota=10,
        created_at=3_820,
    )
    conn.executescript(enforce_path.read_text(encoding="utf-8"))
    historical_zero_count = conn.execute(
        "SELECT count(*) FROM task_billing_intents "
        "WHERE reservation_key IN ('0038-preexisting', '0038-late-old-writer') "
        "AND submit_deadline_at = 0"
    ).fetchone()[0]
    if historical_zero_count != 2:
        raise SystemExit("0039 enforcement rewrote historical zero-deadline rows")

    expect_integrity_error(
        lambda: insert_legacy_intent("0039-blocked-old-writer", 3_830),
        "0039 must block a writer without a submit deadline",
        "task submit operation contract is invalid",
    )
    insert_task_billing_intent(
        conn,
        "0039-new-writer",
        user_id,
        token_id,
        channel_id,
        quota=10,
        created_at=3_840,
    )


def verify_task_poll_lease_rollout(schema_paths: list[Path]) -> None:
    expand_path = next(
        (path for path in schema_paths if path.name == "0034_task_poll_lease.sql"),
        None,
    )
    enforce_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0035_task_poll_lease_enforce.sql"
        ),
        None,
    )
    if expand_path is None or enforce_path is None:
        raise SystemExit("0034/0035 task poll lease rollout migrations not found")
    if schema_paths.index(expand_path) >= schema_paths.index(enforce_path):
        raise SystemExit("0034 task poll lease expand migration must precede 0035 enforce")

    expand_sql = expand_path.read_text(encoding="utf-8")
    enforce_sql = enforce_path.read_text(encoding="utf-8")
    if "if not exists" in expand_sql.lower() or "if not exists" in enforce_sql.lower():
        raise SystemExit("0034/0035 critical task poll objects must fail on duplicate DDL")

    required_expand_fragments = (
        "ADD COLUMN poll_owner",
        "ADD COLUMN poll_generation",
        "ADD COLUMN poll_lease_expires_at",
        "ADD COLUMN poll_applied_generation",
        "ADD COLUMN poll_write_revision",
        "CREATE TABLE task_poll_lease_control",
        "CREATE INDEX idx_tasks_poll_lease_due",
        "CREATE INDEX idx_midjourneys_poll_lease_due",
    )
    for fragment in required_expand_fragments:
        if fragment not in expand_sql:
            raise SystemExit(f"0034 task poll lease expand contract missing: {fragment}")

    required_enforce_objects = (
        "task_poll_lease_shape_guard",
        "midjourney_poll_lease_shape_guard",
        "task_poll_write_revision_guard",
        "midjourney_poll_write_revision_guard",
    )
    for trigger in required_enforce_objects:
        if f"CREATE TRIGGER {trigger}" not in enforce_sql:
            raise SystemExit(f"0035 task poll lease enforcement missing: {trigger}")
    normalized_enforce_sql = " ".join(enforce_sql.lower().split())
    renewal_guard = (
        "new.poll_lease_expires_at > old.poll_lease_expires_at "
        "and new.poll_generation <= old.poll_generation"
    )
    if normalized_enforce_sql.count(renewal_guard) < 2:
        raise SystemExit(
            "0035 task and Midjourney shape guards must reject generationless lease renewal"
        )

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == expand_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))

    conn.executescript(expand_sql)
    control = conn.execute(
        "SELECT contract_version, authority_enabled, enforcement_enabled, updated_at "
        "FROM task_poll_lease_control WHERE id = 1"
    ).fetchone()
    if control != (1, 0, 0, 0):
        raise SystemExit(f"0034 task poll lease expand must remain inert: {control}")
    if any(trigger_exists(conn, trigger) for trigger in required_enforce_objects):
        raise SystemExit("0034 expand migration unexpectedly installed 0035 triggers")

    conn.execute(
        "INSERT INTO tasks "
        "(id, task_id, upstream_task_id, platform, status, progress, submit_time) "
        "VALUES (340034, '0034-rollout-task', 'provider-0034', 'sora', "
        "'IN_PROGRESS', '1%', 1)"
    )
    if conn.execute(
        "UPDATE tasks SET progress = '2%' WHERE id = 340034"
    ).rowcount != 1:
        raise SystemExit("0034 expand migration broke legacy task lifecycle writes")

    conn.executescript(enforce_sql)
    control_after_enforce = conn.execute(
        "SELECT authority_enabled, enforcement_enabled "
        "FROM task_poll_lease_control WHERE id = 1"
    ).fetchone()
    if control_after_enforce != (0, 0):
        raise SystemExit(
            f"0035 enforcement migration must remain default off: {control_after_enforce}"
        )
    if conn.execute(
        "UPDATE tasks SET progress = '3%' WHERE id = 340034"
    ).rowcount != 1:
        raise SystemExit("0035 default-off enforcement blocked a legacy task writer")

    for trigger in required_enforce_objects:
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0035 rollout trigger missing after apply: {trigger}")

    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE tasks SET poll_owner = 'invalid-owner' WHERE id = 340034"
        ),
        "0035 shape guard must stay active while lifecycle enforcement is off",
        "invalid task poll lease transition",
    )


def verify_task_poll_schedule_rollout(schema_paths: list[Path]) -> None:
    schedule_path = next(
        (path for path in schema_paths if path.name == "0036_task_poll_schedule.sql"),
        None,
    )
    enforce_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0035_task_poll_lease_enforce.sql"
        ),
        None,
    )
    if schedule_path is None or enforce_path is None:
        raise SystemExit("0035/0036 task poll scheduler rollout migrations not found")
    if schema_paths.index(enforce_path) >= schema_paths.index(schedule_path):
        raise SystemExit("0035 task poll lease enforcement must precede 0036 scheduler")

    schedule_sql = schedule_path.read_text(encoding="utf-8")
    if "if not exists" in schedule_sql.lower():
        raise SystemExit("0036 critical scheduler objects must fail on duplicate DDL")
    required_fragments = (
        "ADD COLUMN next_poll_at",
        "ADD COLUMN poll_attempt_count",
        "ADD COLUMN poll_consecutive_failures",
        "ADD COLUMN poll_last_attempt_at",
        "ADD COLUMN poll_last_error_code",
        "ADD COLUMN poll_quarantined_at",
        "ADD COLUMN poll_quarantine_reason",
        "CREATE INDEX idx_tasks_poll_schedule_due",
        "CREATE INDEX idx_midjourneys_poll_schedule_due",
        "CREATE TABLE task_poll_family_cursors",
        "round_high_watermark",
        "CHECK (round_high_watermark >= last_row_id)",
    )
    for fragment in required_fragments:
        if fragment not in schedule_sql:
            raise SystemExit(f"0036 scheduler rollout contract missing: {fragment}")
    for family in (
        "video",
        "suno",
        "midjourney",
        "task_timeout",
        "midjourney_timeout",
    ):
        if f"('{family}')" not in schedule_sql:
            raise SystemExit(f"0036 scheduler cursor seed missing: {family}")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == schedule_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute(
        "INSERT INTO tasks "
        "(id, task_id, upstream_task_id, platform, status, progress, submit_time) "
        "VALUES (360036, '0036-rollout-task', 'provider-0036', 'sora', "
        "'IN_PROGRESS', '7%', 10)"
    )
    conn.execute(
        "INSERT INTO midjourneys (id, mj_id, status, progress, submit_time) "
        "VALUES (360037, '0036-rollout-mj', 'IN_PROGRESS', '8%', 11)"
    )
    before = (
        conn.execute(
            "SELECT task_id, upstream_task_id, platform, status, progress, submit_time "
            "FROM tasks WHERE id = 360036"
        ).fetchone(),
        conn.execute(
            "SELECT mj_id, status, progress, submit_time "
            "FROM midjourneys WHERE id = 360037"
        ).fetchone(),
    )
    conn.executescript(schedule_sql)
    after = (
        conn.execute(
            "SELECT task_id, upstream_task_id, platform, status, progress, submit_time "
            "FROM tasks WHERE id = 360036"
        ).fetchone(),
        conn.execute(
            "SELECT mj_id, status, progress, submit_time "
            "FROM midjourneys WHERE id = 360037"
        ).fetchone(),
    )
    if after != before:
        raise SystemExit(f"0036 scheduler migration changed business data: {after}")
    defaults = conn.execute(
        "SELECT next_poll_at, poll_attempt_count, poll_consecutive_failures, "
        "poll_last_attempt_at, poll_last_error_code, poll_quarantined_at, "
        "poll_quarantine_reason FROM tasks WHERE id = 360036"
    ).fetchone()
    if defaults != (0, 0, 0, 0, "", 0, ""):
        raise SystemExit(f"0036 rollout backfill is not default-inert: {defaults}")
    cursor_count = conn.execute(
        "SELECT COUNT(*) FROM task_poll_family_cursors WHERE last_row_id = 0 "
        "AND round_high_watermark = 0 AND scan_generation = 0 AND updated_at = 0"
    ).fetchone()[0]
    if cursor_count != 5:
        raise SystemExit(f"0036 rollout did not seed five inert cursors: {cursor_count}")
    if conn.execute(
        "UPDATE tasks SET progress = '9%' WHERE id = 360036"
    ).rowcount != 1:
        raise SystemExit("0036 default-inert scheduler broke a 0035-compatible task writer")
    if conn.execute(
        "UPDATE midjourneys SET progress = '10%' WHERE id = 360037"
    ).rowcount != 1:
        raise SystemExit(
            "0036 default-inert scheduler broke a 0035-compatible Midjourney writer"
        )


def verify_task_poll_recovery_rollout(schema_paths: list[Path]) -> None:
    recovery_path = next(
        (path for path in schema_paths if path.name == "0037_task_poll_recovery.sql"),
        None,
    )
    schedule_path = next(
        (path for path in schema_paths if path.name == "0036_task_poll_schedule.sql"),
        None,
    )
    if recovery_path is None or schedule_path is None:
        raise SystemExit("0036/0037 task poll recovery rollout migrations not found")
    if schema_paths.index(schedule_path) >= schema_paths.index(recovery_path):
        raise SystemExit("0036 scheduler must precede 0037 task poll recovery")

    recovery_sql = recovery_path.read_text(encoding="utf-8")
    if "if not exists" in recovery_sql.lower():
        raise SystemExit("0037 critical recovery objects must fail on duplicate DDL")
    required_fragments = (
        "CREATE TABLE task_poll_recovery_events",
        "CREATE INDEX idx_task_poll_recovery_events_entity",
        "CREATE UNIQUE INDEX idx_task_poll_recovery_events_revision",
        "CREATE INDEX idx_tasks_poll_quarantine_queue",
        "CREATE INDEX idx_midjourneys_poll_quarantine_queue",
        "CREATE TRIGGER task_poll_recovery_event_update_guard",
        "CREATE TRIGGER task_poll_recovery_event_delete_guard",
        "CREATE TRIGGER task_poll_recovery_task_guard",
        "CREATE TRIGGER task_poll_recovery_midjourney_guard",
        "CREATE TRIGGER task_poll_recovery_task_apply",
        "CREATE TRIGGER task_poll_recovery_midjourney_apply",
        "poll_owner = ''",
        "poll_lease_expires_at = 0",
        "poll_generation = NEW.expected_poll_generation",
        "poll_write_revision = NEW.expected_poll_write_revision",
        "poll_write_revision = poll_write_revision + 1",
        "expected_hard_timeout_at",
    )
    for fragment in required_fragments:
        if fragment not in recovery_sql:
            raise SystemExit(f"0037 recovery rollout contract missing: {fragment}")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == recovery_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute(
        "INSERT INTO tasks "
        "(id, task_id, upstream_task_id, platform, status, progress, submit_time, "
        "poll_quarantined_at, poll_quarantine_reason) "
        "VALUES (370037, '0037-rollout-task', 'provider-0037', 'sora', "
        "'IN_PROGRESS', '17%', 10, 20, 'provider_poll_failed')"
    )
    conn.execute(
        "INSERT INTO midjourneys "
        "(id, mj_id, status, progress, submit_time, poll_quarantined_at, "
        "poll_quarantine_reason) VALUES "
        "(370038, '0037-rollout-mj', 'IN_PROGRESS', '18%', 11, 21, "
        "'provider_item_missing')"
    )
    before = (
        conn.execute(
            "SELECT task_id, upstream_task_id, platform, status, progress, "
            "poll_quarantined_at, poll_quarantine_reason "
            "FROM tasks WHERE id = 370037"
        ).fetchone(),
        conn.execute(
            "SELECT mj_id, status, progress, poll_quarantined_at, "
            "poll_quarantine_reason FROM midjourneys WHERE id = 370038"
        ).fetchone(),
    )
    conn.executescript(recovery_sql)
    after = (
        conn.execute(
            "SELECT task_id, upstream_task_id, platform, status, progress, "
            "poll_quarantined_at, poll_quarantine_reason "
            "FROM tasks WHERE id = 370037"
        ).fetchone(),
        conn.execute(
            "SELECT mj_id, status, progress, poll_quarantined_at, "
            "poll_quarantine_reason FROM midjourneys WHERE id = 370038"
        ).fetchone(),
    )
    if after != before:
        raise SystemExit(f"0037 recovery migration changed business data: {after}")
    if conn.execute("SELECT COUNT(*) FROM task_poll_recovery_events").fetchone() != (0,):
        raise SystemExit("0037 recovery migration must not synthesize events")
    if conn.execute(
        "UPDATE tasks SET next_poll_at = 30 WHERE id = 370037"
    ).rowcount != 1:
        raise SystemExit("0037 recovery rollout broke a 0036-compatible task writer")
    if conn.execute(
        "UPDATE midjourneys SET next_poll_at = 31 WHERE id = 370038"
    ).rowcount != 1:
        raise SystemExit("0037 recovery rollout broke a 0036-compatible Midjourney writer")


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {
        row[1]
        for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    }


def table_indexes(conn: sqlite3.Connection, table: str) -> dict[str, bool]:
    return {
        row[1]: bool(row[2])
        for row in conn.execute(f'PRAGMA index_list("{table}")').fetchall()
    }


def sqlite_object_sql(
    conn: sqlite3.Connection, object_type: str, name: str
) -> str | None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
        (object_type, name),
    ).fetchone()
    return row[0] if row else None


if __name__ == "__main__":
    raise SystemExit(main())
