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
    "relay_container_operations",
    "relay_container_terminal_events",
    "relay_container_terminal_outbox_state",
    "relay_container_reconciliation_observations",
    "relay_container_reconciliation_cursor",
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
    "relay_container_operations": {
        "reservation_key",
        "operation_id",
        "owner_generation",
        "owner_lease_expires_at",
        "channel_id",
        "selected_group",
        "operation_kind",
        "provider_operation_id",
        "admission_sha256",
        "protocol_version",
        "shard_contract_version",
        "ring_generation",
        "shard_count",
        "shard_index",
        "instance_name",
        "execution_deadline_at",
        "input_mode",
        "input_object_key",
        "input_object_version",
        "input_sha256",
        "input_size",
        "input_content_type",
        "trace_id",
        "client_idempotency_hmac_sha256",
        "client_request_sha256",
        "reconciliation_id",
        "status",
        "response_status",
        "response_code",
        "result_object_key",
        "result_object_version",
        "result_sha256",
        "result_size",
        "result_content_type",
        "created_at",
        "updated_at",
    },
    "relay_container_terminal_events": {
        "billing_event_id",
        "reservation_key",
        "operation_id",
        "owner_generation",
        "operation_from_status",
        "operation_status",
        "terminal_contract_sha256",
        "billing_action",
        "billing_owner_generation",
        "billing_from_status",
        "billing_final_quota",
        "billing_request_accounted",
        "billing_reason",
        "pre_consumed_quota",
        "user_quota_delta",
        "token_quota_delta",
        "user_used_quota_delta",
        "channel_used_quota_delta",
        "request_count_delta",
        "reconciliation_id",
        "reconciliation_revision",
        "client_response_status",
        "client_response_headers_json",
        "client_response_headers_sha256",
        "client_response_object_key",
        "client_response_object_version",
        "client_response_sha256",
        "client_response_size",
        "client_response_content_type",
        "outbox_schema_version",
        "outbox_payload_json",
        "outbox_payload_sha256",
        "created_at",
    },
    "relay_container_terminal_outbox_state": {
        "billing_event_id",
        "status",
        "delivery_generation",
        "delivery_attempt_count",
        "lease_expires_at",
        "available_at",
        "delivered_at",
        "last_error",
        "created_at",
        "updated_at",
    },
    "relay_container_reconciliation_observations": {
        "operation_id",
        "reservation_key",
        "operation_created_at",
        "owner_generation",
        "reconciliation_id",
        "status",
        "claim_generation",
        "claim_owner",
        "claim_lease_expires_at",
        "available_at",
        "attempt_count",
        "consecutive_failures",
        "first_observed_at",
        "last_attempt_at",
        "last_observed_at",
        "last_class",
        "last_error_code",
        "recovery_deadline_at",
        "converged_at",
        "dead_lettered_at",
        "dead_letter_reason",
        "created_at",
        "updated_at",
    },
    "relay_container_reconciliation_cursor": {
        "cursor_name",
        "last_created_at",
        "last_reservation_key",
        "round_high_created_at",
        "round_high_reservation_key",
        "scan_generation",
        "run_generation",
        "run_owner",
        "run_lease_expires_at",
        "last_started_at",
        "last_completed_at",
        "last_success_at",
        "last_error_code",
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
    "relay_container_operations": {
        "idx_relay_container_operations_recovery": False,
        "idx_relay_container_operations_shard": False,
        "idx_relay_container_operations_updated": False,
        "idx_relay_container_operations_client_idempotency_hmac": True,
        "idx_relay_container_operations_reconciliation_id": True,
    },
    "relay_container_terminal_events": {
        "idx_relay_container_terminal_events_operation_identity": True,
        "idx_relay_container_terminal_events_reconciliation_identity": True,
    },
    "relay_container_terminal_outbox_state": {
        "idx_relay_container_terminal_outbox_pending": False,
        "idx_relay_container_terminal_outbox_leased": False,
    },
    "relay_container_reconciliation_observations": {
        "idx_relay_container_reconciliation_observations_due": False,
        "idx_relay_container_reconciliation_observations_lease": False,
        "idx_relay_container_reconciliation_observations_class": False,
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
    relay_container_operation_verified = False
    relay_container_operation_rollout_verified = False
    relay_container_financial_terminal_verified = False
    relay_container_financial_terminal_rollout_verified = False
    relay_container_reconciliation_observer_verified = False
    relay_container_reconciliation_observer_rollout_verified = False
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
        verify_relay_container_operation_rollout(schema_paths)
        relay_container_operation_rollout_verified = True
        verify_relay_container_financial_terminal_rollout(schema_paths)
        relay_container_financial_terminal_rollout_verified = True
        verify_relay_container_reconciliation_observer_rollout(schema_paths)
        relay_container_reconciliation_observer_rollout_verified = True
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
        verify_relay_container_operation(conn)
        relay_container_operation_verified = True
        verify_relay_container_financial_terminal(conn)
        relay_container_financial_terminal_verified = True
        verify_relay_container_reconciliation_observer(conn)
        relay_container_reconciliation_observer_verified = True
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
    if relay_container_operation_verified:
        message += " + 0040/0041 relay Container operation authority"
    if relay_container_operation_rollout_verified:
        message += " + 0040/0041 default-inert expand/hardening rollout"
    if relay_container_financial_terminal_verified:
        message += " + 0042 immutable financial terminal/outbox contract"
    if relay_container_financial_terminal_rollout_verified:
        message += " + 0042 default-inert expand-only rollout"
    if relay_container_reconciliation_observer_verified:
        message += " + 0043 generation-fenced Container reconciliation observer"
    if relay_container_reconciliation_observer_rollout_verified:
        message += " + 0043 default-lazy observer expand rollout"
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


def verify_relay_container_operation(conn: sqlite3.Connection) -> None:
    for trigger in (
        "relay_container_operation_identity_immutable_guard",
        "relay_container_operation_lifecycle_guard",
    ):
        if not trigger_exists(conn, trigger):
            raise SystemExit(
                f"0040/0041 relay Container operation trigger missing: {trigger}"
            )

    lifecycle_sql = sqlite_object_sql(
        conn, "trigger", "relay_container_operation_lifecycle_guard"
    )
    for fragment in (
        "OLD.status IN ('completed', 'failed')",
        "OLD.status = 'prepared'",
        "OLD.status = 'dispatched'",
        "OLD.status = 'recovery_required'",
        "NEW.status IN ('completed', 'failed')",
        "NEW.status = OLD.status",
        "NEW.response_status IS NOT OLD.response_status",
        "NEW.result_object_key IS NOT OLD.result_object_key",
        "NEW.updated_at IS NOT OLD.updated_at",
    ):
        if lifecycle_sql is None or fragment not in lifecycle_sql:
            raise SystemExit(f"0041 lifecycle hardening missing: {fragment}")

    recovery_index_sql = sqlite_object_sql(
        conn, "index", "idx_relay_container_operations_recovery"
    )
    if recovery_index_sql is None or "WHERE status IN" not in recovery_index_sql:
        raise SystemExit("0040 recovery index must remain partial and status-bounded")

    def insert_operation(
        reservation_key: str | None,
        provider_operation_id: str,
        shard_index: int,
        **overrides: object,
    ) -> None:
        values: dict[str, object] = {
            "reservation_key": reservation_key,
            "operation_id": reservation_key,
            "owner_generation": 2,
            "owner_lease_expires_at": 5100,
            "channel_id": 40,
            "selected_group": "default",
            "operation_kind": "relay_chat",
            "provider_operation_id": provider_operation_id,
            "admission_sha256": "a" * 64,
            "protocol_version": 1,
            "shard_contract_version": 1,
            "ring_generation": 7,
            "shard_count": 8,
            "shard_index": shard_index,
            "instance_name": f"cinatoken-relay-shard-v1-{shard_index:04d}",
            "execution_deadline_at": 5000,
            "input_mode": "r2",
            "input_object_key": (
                f"container-inputs/v1/{reservation_key}/2/{'b' * 64}"
            ),
            "input_object_version": "r2-version-1",
            "input_sha256": "b" * 64,
            "input_size": 128,
            "input_content_type": "application/json",
            "trace_id": f"trace:{reservation_key}",
            "status": "prepared",
            "response_status": None,
            "response_code": None,
            "result_object_key": None,
            "result_object_version": None,
            "result_sha256": None,
            "result_size": None,
            "result_content_type": None,
            "created_at": 4000,
            "updated_at": 4000,
        }
        values.update(overrides)
        conn.execute(
            """
            INSERT INTO relay_container_operations (
              reservation_key, operation_id,
              owner_generation, owner_lease_expires_at, channel_id, selected_group,
              operation_kind, provider_operation_id, admission_sha256,
              protocol_version, shard_contract_version,
              ring_generation, shard_count, shard_index,
              instance_name, execution_deadline_at, input_mode, input_object_key,
              input_object_version, input_sha256, input_size,
              input_content_type, trace_id, status, response_status, response_code,
              result_object_key, result_object_version, result_sha256,
              result_size, result_content_type, created_at, updated_at
            ) VALUES (
              :reservation_key, :operation_id,
              :owner_generation, :owner_lease_expires_at, :channel_id, :selected_group,
              :operation_kind, :provider_operation_id, :admission_sha256,
              :protocol_version, :shard_contract_version,
              :ring_generation, :shard_count, :shard_index,
              :instance_name, :execution_deadline_at, :input_mode, :input_object_key,
              :input_object_version, :input_sha256, :input_size,
              :input_content_type, :trace_id, :status, :response_status, :response_code,
              :result_object_key, :result_object_version, :result_sha256,
              :result_size, :result_content_type, :created_at, :updated_at
            )
            """,
            values,
        )

    insert_operation("0040-operation", "provider:0040-operation", 3)
    state = conn.execute(
        "SELECT status, response_status, response_code, result_object_key "
        "FROM relay_container_operations WHERE reservation_key = '0040-operation'"
    ).fetchone()
    if state != ("prepared", None, None, None):
        raise SystemExit(f"0040 prepared operation shape is not default-inert: {state}")

    expect_integrity_error(
        lambda: insert_operation(
            "0040-provider-duplicate", "provider:0040-operation", 4
        ),
        "0040 provider operation identity must be globally unique",
        "UNIQUE constraint failed",
    )
    expect_integrity_error(
        lambda: insert_operation(None, "provider:0040-null-key", 4),
        "0040 reservation identity must reject a null primary key",
        "NOT NULL constraint failed",
    )
    expect_integrity_error(
        lambda: insert_operation(
            "0040-operation-id-conflict",
            "provider:0040-operation-id-conflict",
            4,
            operation_id="0040-another-operation",
        ),
        "0040 operation identity must equal its reservation identity",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_operation(
            "0040-text-owner",
            "provider:0040-text-owner",
            4,
            owner_generation="not-an-integer",
        ),
        "0040 integer authority must reject text affinity bypasses",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_operation(
            "0040-null-terminal",
            "provider:0040-null-terminal",
            4,
            status="completed",
        ),
        "0040 terminal rows must reject nullable outcome fields",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations SET reservation_key = '0040-rewritten' "
            "WHERE reservation_key = '0040-operation'"
        ),
        "0040 operation identity must be immutable",
        "relay container operation identity is immutable",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations SET updated_at = 3999 "
            "WHERE reservation_key = '0040-operation'"
        ),
        "0040 operation timestamps must remain monotonic",
        "relay container operation lifecycle transition is invalid",
    )

    conn.execute(
        "UPDATE relay_container_operations "
        "SET status = 'dispatched', updated_at = 4100 "
        "WHERE reservation_key = '0040-operation'"
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET status = 'dispatched', updated_at = 4101 "
            "WHERE reservation_key = '0040-operation'"
        ),
        "0041 dispatched same-state writes must not refresh updated_at",
        "relay container operation lifecycle transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET status = 'completed', response_status = 200, updated_at = 4200 "
            "WHERE reservation_key = '0040-operation'"
        ),
        "0040 completion must require an exact result object",
        "CHECK constraint failed",
    )

    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'completed', response_status = 200,
            result_object_key = 'container-results/v1/0040-operation/2/' || ?,
            result_object_version = 'r2-result-version-1',
            result_sha256 = ?, result_size = 256,
            result_content_type = 'application/json', updated_at = 4300
        WHERE reservation_key = '0040-operation'
        """,
        ("c" * 64, "c" * 64),
    )
    completed = conn.execute(
        "SELECT status, response_status, result_object_version, result_sha256 "
        "FROM relay_container_operations WHERE reservation_key = '0040-operation'"
    ).fetchone()
    if completed != ("completed", 200, "r2-result-version-1", "c" * 64):
        raise SystemExit(f"0040 completed operation shape was not persisted: {completed}")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations SET status = status "
            "WHERE reservation_key = '0040-operation'"
        ),
        "0041 completed operations must reject every update",
        "relay container operation lifecycle transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET status = 'prepared', response_status = NULL, "
            "result_object_key = NULL, result_object_version = NULL, "
            "result_sha256 = NULL, result_size = NULL, result_content_type = NULL, "
            "updated_at = 4400 WHERE reservation_key = '0040-operation'"
        ),
        "0040 terminal operations must not reactivate",
        "relay container operation lifecycle transition is invalid",
    )

    insert_operation("0040-recovery", "provider:0040-recovery", 4)
    conn.execute(
        "UPDATE relay_container_operations "
        "SET status = 'dispatched', updated_at = 4100 "
        "WHERE reservation_key = '0040-recovery'"
    )
    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'recovery_required', response_status = 202,
            response_code = 'container_execution_ambiguous', updated_at = 4200
        WHERE reservation_key = '0040-recovery'
        """
    )
    recovery = conn.execute(
        "SELECT status, response_status, response_code, result_object_key "
        "FROM relay_container_operations WHERE reservation_key = '0040-recovery'"
    ).fetchone()
    if recovery != (
        "recovery_required",
        202,
        "container_execution_ambiguous",
        None,
    ):
        raise SystemExit(f"0040 recovery operation shape was not persisted: {recovery}")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations SET updated_at = 4300 "
            "WHERE reservation_key = '0040-recovery'"
        ),
        "0041 recovery same-state writes must not refresh updated_at",
        "relay container operation lifecycle transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET response_code = 'container_execution_rewritten' "
            "WHERE reservation_key = '0040-recovery'"
        ),
        "0041 recovery same-state writes must not rewrite response fields",
        "relay container operation lifecycle transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_operations
            SET result_object_key = 'container-results/v1/0040-recovery/2/' || ?,
                result_object_version = 'r2-rewritten-result-version',
                result_sha256 = ?, result_size = 512,
                result_content_type = 'application/json'
            WHERE reservation_key = '0040-recovery'
            """,
            ("d" * 64, "d" * 64),
        ),
        "0041 recovery same-state writes must not rewrite result fields",
        "relay container operation lifecycle transition is invalid",
    )

    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'completed', response_status = 200, response_code = NULL,
            result_object_key = 'container-results/v1/0040-recovery/2/' || ?,
            result_object_version = 'r2-recovered-result-version',
            result_sha256 = ?, result_size = 384,
            result_content_type = 'application/json', updated_at = 4400
        WHERE reservation_key = '0040-recovery'
        """,
        ("e" * 64, "e" * 64),
    )
    recovered_completed = conn.execute(
        "SELECT status, response_status, response_code, result_sha256 "
        "FROM relay_container_operations WHERE reservation_key = '0040-recovery'"
    ).fetchone()
    if recovered_completed != ("completed", 200, None, "e" * 64):
        raise SystemExit(
            "0041 recovery-to-completed transition was not persisted: "
            f"{recovered_completed}"
        )

    insert_operation("0041-recovery-failed", "provider:0041-recovery-failed", 5)
    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'recovery_required', response_status = 202,
            response_code = 'container_execution_ambiguous', updated_at = 4100
        WHERE reservation_key = '0041-recovery-failed'
        """
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET status = 'dispatched', response_status = NULL, response_code = NULL, "
            "updated_at = 4150 WHERE reservation_key = '0041-recovery-failed'"
        ),
        "0041 recovery operations must only transition to completed or failed",
        "relay container operation lifecycle transition is invalid",
    )
    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'failed', response_status = 503,
            response_code = 'container_recovery_failed', updated_at = 4200
        WHERE reservation_key = '0041-recovery-failed'
        """
    )
    recovered_failed = conn.execute(
        "SELECT status, response_status, response_code, result_object_key "
        "FROM relay_container_operations "
        "WHERE reservation_key = '0041-recovery-failed'"
    ).fetchone()
    if recovered_failed != ("failed", 503, "container_recovery_failed", None):
        raise SystemExit(
            "0041 recovery-to-failed transition was not persisted: "
            f"{recovered_failed}"
        )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET status = 'prepared', response_status = NULL, response_code = NULL, "
            "updated_at = 4300 WHERE reservation_key = '0041-recovery-failed'"
        ),
        "0041 failed operations must not reactivate",
        "relay container operation lifecycle transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations SET status = status "
            "WHERE reservation_key = '0041-recovery-failed'"
        ),
        "0041 failed operations must reject every update",
        "relay container operation lifecycle transition is invalid",
    )

    insert_operation("0041-prepared-failed", "provider:0041-prepared-failed", 6)
    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'failed', response_status = 500,
            response_code = 'container_preparation_failed', updated_at = 4100
        WHERE reservation_key = '0041-prepared-failed'
        """
    )
    insert_operation("0041-dispatched-failed", "provider:0041-dispatched-failed", 7)
    conn.execute(
        "UPDATE relay_container_operations "
        "SET status = 'dispatched', updated_at = 4100 "
        "WHERE reservation_key = '0041-dispatched-failed'"
    )
    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'failed', response_status = 502,
            response_code = 'container_dispatch_failed', updated_at = 4200
        WHERE reservation_key = '0041-dispatched-failed'
        """
    )
    preserved_transitions = conn.execute(
        "SELECT reservation_key, status FROM relay_container_operations "
        "WHERE reservation_key IN ('0041-prepared-failed', '0041-dispatched-failed') "
        "ORDER BY reservation_key"
    ).fetchall()
    if preserved_transitions != [
        ("0041-dispatched-failed", "failed"),
        ("0041-prepared-failed", "failed"),
    ]:
        raise SystemExit(
            f"0041 changed legal prepared/dispatched transitions: {preserved_transitions}"
        )


def verify_relay_container_financial_terminal(conn: sqlite3.Connection) -> None:
    required_triggers = (
        "relay_container_operation_identity_immutable_guard",
        "relay_container_terminal_event_insert_guard",
        "relay_container_terminal_event_update_guard",
        "relay_container_terminal_event_delete_guard",
        "relay_container_terminal_outbox_insert_guard",
        "relay_container_terminal_outbox_identity_immutable_guard",
        "relay_container_terminal_outbox_lifecycle_guard",
        "relay_container_terminal_outbox_delete_guard",
    )
    for trigger in required_triggers:
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0042 financial terminal trigger missing: {trigger}")

    identity_sql = sqlite_object_sql(
        conn, "trigger", "relay_container_operation_identity_immutable_guard"
    )
    for fragment in (
        "client_idempotency_hmac_sha256",
        "client_request_sha256",
        "reconciliation_id",
        "relay container operation identity is immutable",
    ):
        if identity_sql is None or fragment not in identity_sql:
            raise SystemExit(f"0042 operation identity trigger missing: {fragment}")

    event_table_sql = sqlite_object_sql(
        conn, "table", "relay_container_terminal_events"
    )
    for fragment in (
        "typeof(billing_event_id) = 'text'",
        "billing_from_status IN ('reserved', 'recovery_required')",
        "typeof(pre_consumed_quota) = 'integer'",
        "typeof(user_quota_delta) = 'integer'",
        "typeof(token_quota_delta) = 'integer'",
        "typeof(user_used_quota_delta) = 'integer'",
        "typeof(channel_used_quota_delta) = 'integer'",
        "typeof(request_count_delta) = 'integer'",
        "json_valid(client_response_headers_json)",
        "json_valid(outbox_payload_json)",
        "container-client-responses/v1/",
        "billing_action = 'settle'",
        "billing_action = 'refund'",
        "billing_action = 'recovery_required'",
    ):
        if event_table_sql is None or fragment not in event_table_sql:
            raise SystemExit(f"0042 terminal event schema missing: {fragment}")

    outbox_table_sql = sqlite_object_sql(
        conn, "table", "relay_container_terminal_outbox_state"
    )
    for fragment in (
        "status IN ('pending', 'leased', 'delivered', 'dead_letter')",
        "delivery_generation = delivery_attempt_count",
        "lease_expires_at > updated_at",
        "delivered_at = updated_at",
        "REFERENCES relay_container_terminal_events(billing_event_id)",
    ):
        if outbox_table_sql is None or fragment not in outbox_table_sql:
            raise SystemExit(f"0042 terminal outbox schema missing: {fragment}")

    partial_indexes = {
        "idx_relay_container_operations_client_idempotency_hmac": (
            "WHERE client_idempotency_hmac_sha256 <> ''"
        ),
        "idx_relay_container_operations_reconciliation_id": (
            "WHERE reconciliation_id <> ''"
        ),
        "idx_relay_container_terminal_outbox_pending": "WHERE status = 'pending'",
        "idx_relay_container_terminal_outbox_leased": "WHERE status = 'leased'",
    }
    for index_name, predicate in partial_indexes.items():
        index_sql = sqlite_object_sql(conn, "index", index_name)
        if index_sql is None or predicate not in index_sql:
            raise SystemExit(f"0042 partial index SQL missing: {index_name}")

    user_id = 420042
    token_id = 420042
    channel_id = 420042
    conn.execute(
        """
        INSERT INTO users (
          id, username, password, quota, used_quota, request_count,
          aff_code, created_at
        ) VALUES (
          ?, 'sqlite-0042-user', 'not-used', 1000, 50, 3,
          'sqlite-0042-aff', 1
        )
        """,
        (user_id,),
    )
    conn.execute(
        """
        INSERT INTO tokens (
          id, user_id, "key", remain_quota, used_quota, accessed_time
        ) VALUES (?, ?, 'sqlite-0042-token', 800, 200, 1)
        """,
        (token_id, user_id),
    )
    conn.execute(
        """
        INSERT INTO channels (id, "key", name, used_quota)
        VALUES (?, 'sqlite-0042-channel-key', 'sqlite-0042-channel', 300)
        """,
        (channel_id,),
    )

    authorities: dict[str, dict[str, object]] = {}

    def digest(label: str) -> str:
        return hashlib.sha256(label.encode("utf-8")).hexdigest()

    def insert_authority(
        key: str,
        *,
        operation_status: str = "dispatched",
        billing_status: str = "reserved",
        operation_owner_generation: int = 5,
        billing_owner_generation: int = 5,
        billing_token_id: int = token_id,
        pre_consumed_quota: int = 120,
        operation_group: str = "default",
        billing_group: str = "default",
        client_hmac: str | None = None,
        client_request: str | None = None,
        reconciliation_id: str | None = None,
        legacy_identity: bool = False,
    ) -> dict[str, object]:
        if legacy_identity:
            resolved_client_hmac = "" if client_hmac is None else client_hmac
            resolved_client_request = "" if client_request is None else client_request
            resolved_reconciliation_id = (
                "" if reconciliation_id is None else reconciliation_id
            )
        else:
            resolved_client_hmac = client_hmac or digest(f"client:{key}")
            resolved_client_request = client_request or digest(f"request:{key}")
            resolved_reconciliation_id = reconciliation_id or digest(
                f"reconciliation:{key}"
            )
        billing_reason = (
            "container_execution_ambiguous"
            if billing_status == "recovery_required"
            else ""
        )
        billing_updated_at = 7200 if billing_status == "recovery_required" else 6600
        billing_recovery_at = 7200 if billing_status == "recovery_required" else 0
        conn.execute(
            """
            INSERT INTO relay_billing_reservations (
              reservation_key, user_id, token_id, model_name,
              pre_consumed_quota, status,
              channel_id, selected_group, selected_at,
              final_quota, finalization_reason, request_accounted,
              lease_expires_at, owner_generation, owner_deadline_at,
              created_at, updated_at, recovery_required_at
            ) VALUES (
              ?, ?, ?, 'sqlite-0042-model', ?, ?,
              ?, ?, 6550,
              0, ?, 0,
              9000, ?, 8000,
              6500, ?, ?
            )
            """,
            (
                key,
                user_id,
                billing_token_id,
                pre_consumed_quota,
                billing_status,
                channel_id,
                billing_group,
                billing_reason,
                billing_owner_generation,
                billing_updated_at,
                billing_recovery_at,
            ),
        )
        response_status = 202 if operation_status == "recovery_required" else None
        response_code = (
            "container_execution_ambiguous"
            if operation_status == "recovery_required"
            else None
        )
        operation_updated_at = 7300 if operation_status == "recovery_required" else 7100
        values = {
            "reservation_key": key,
            "operation_id": key,
            "owner_generation": operation_owner_generation,
            "owner_lease_expires_at": 9000,
            "channel_id": channel_id,
            "selected_group": operation_group,
            "operation_kind": "relay_chat",
            "provider_operation_id": f"provider:{key}",
            "admission_sha256": digest(f"admission:{key}"),
            "protocol_version": 1,
            "shard_contract_version": 1,
            "ring_generation": 7,
            "shard_count": 8,
            "shard_index": 2,
            "instance_name": "cinatoken-relay-shard-v1-0002",
            "execution_deadline_at": 8000,
            "input_mode": "r2",
            "input_object_key": (
                f"container-inputs/v1/{key}/{operation_owner_generation}/"
                f"{digest(f'input:{key}')}"
            ),
            "input_object_version": "r2-version-0042",
            "input_sha256": digest(f"input:{key}"),
            "input_size": 256,
            "input_content_type": "application/json",
            "trace_id": f"trace:{key}",
            "client_idempotency_hmac_sha256": resolved_client_hmac,
            "client_request_sha256": resolved_client_request,
            "reconciliation_id": resolved_reconciliation_id,
            "status": operation_status,
            "response_status": response_status,
            "response_code": response_code,
            "created_at": 7000,
            "updated_at": operation_updated_at,
        }
        conn.execute(
            """
            INSERT INTO relay_container_operations (
              reservation_key, operation_id,
              owner_generation, owner_lease_expires_at,
              channel_id, selected_group,
              operation_kind, provider_operation_id, admission_sha256,
              protocol_version, shard_contract_version,
              ring_generation, shard_count, shard_index, instance_name,
              execution_deadline_at,
              input_mode, input_object_key, input_object_version,
              input_sha256, input_size, input_content_type, trace_id,
              client_idempotency_hmac_sha256, client_request_sha256,
              reconciliation_id,
              status, response_status, response_code,
              created_at, updated_at
            ) VALUES (
              :reservation_key, :operation_id,
              :owner_generation, :owner_lease_expires_at,
              :channel_id, :selected_group,
              :operation_kind, :provider_operation_id, :admission_sha256,
              :protocol_version, :shard_contract_version,
              :ring_generation, :shard_count, :shard_index, :instance_name,
              :execution_deadline_at,
              :input_mode, :input_object_key, :input_object_version,
              :input_sha256, :input_size, :input_content_type, :trace_id,
              :client_idempotency_hmac_sha256, :client_request_sha256,
              :reconciliation_id,
              :status, :response_status, :response_code,
              :created_at, :updated_at
            )
            """,
            values,
        )
        authority = {
            "operation_owner_generation": operation_owner_generation,
            "billing_owner_generation": billing_owner_generation,
            "token_id": billing_token_id,
            "pre_consumed_quota": pre_consumed_quota,
            "reconciliation_id": resolved_reconciliation_id,
        }
        authorities[key] = authority
        return authority

    insert_authority("0042-legacy-a", legacy_identity=True)
    insert_authority("0042-legacy-b", legacy_identity=True)
    legacy_identities = conn.execute(
        "SELECT COUNT(*) FROM relay_container_operations "
        "WHERE client_idempotency_hmac_sha256 = '' "
        "AND client_request_sha256 = '' AND reconciliation_id = '' "
        "AND reservation_key LIKE '0042-legacy-%'"
    ).fetchone()
    if legacy_identities != (2,):
        raise SystemExit(f"0042 legacy identity compatibility failed: {legacy_identities}")

    expect_integrity_error(
        lambda: insert_authority(
            "0042-mixed-identity",
            legacy_identity=True,
            client_hmac=digest("0042-mixed-client"),
        ),
        "0042 operation identity must be all-empty legacy or all-valid v1",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_authority(
            "0042-uppercase-identity",
            client_hmac="A" * 64,
        ),
        "0042 operation identity must reject uppercase digests",
        "CHECK constraint failed",
    )

    v1_authority = insert_authority("0042-v1-identity")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_operations "
            "SET client_request_sha256 = ? "
            "WHERE reservation_key = '0042-v1-identity'",
            (digest("rewritten-client-request"),),
        ),
        "0042 client request identity must be immutable",
        "relay container operation identity is immutable",
    )
    existing_client_hmac = conn.execute(
        "SELECT client_idempotency_hmac_sha256 "
        "FROM relay_container_operations "
        "WHERE reservation_key = '0042-v1-identity'"
    ).fetchone()[0]
    expect_integrity_error(
        lambda: insert_authority(
            "0042-duplicate-client",
            client_hmac=existing_client_hmac,
        ),
        "0042 non-empty client idempotency HMAC must be unique",
        "UNIQUE constraint failed",
    )
    expect_integrity_error(
        lambda: insert_authority(
            "0042-duplicate-reconciliation",
            reconciliation_id=str(v1_authority["reconciliation_id"]),
        ),
        "0042 non-empty operation reconciliation identity must be unique",
        "UNIQUE constraint failed",
    )

    event_counter = 0

    def terminal_values(
        key: str,
        label: str,
        action: str,
        *,
        operation_from_status: str = "dispatched",
        reconciliation_revision: int = 1,
        **overrides: object,
    ) -> dict[str, object]:
        nonlocal event_counter
        event_counter += 1
        authority = authorities[key]
        pre_consumed_quota = int(authority["pre_consumed_quota"])
        operation_owner_generation = int(authority["operation_owner_generation"])
        billing_owner_generation = int(authority["billing_owner_generation"])
        billing_token_id = int(authority["token_id"])
        body_sha256 = digest(f"client-response:{label}")
        if action == "settle":
            operation_status = "completed"
            billing_final_quota: object = 80
            billing_request_accounted = 1
            frozen_pre_consumed_quota = pre_consumed_quota
            user_quota_delta = pre_consumed_quota - 80
            token_quota_delta = 0 if billing_token_id == 0 else user_quota_delta
            user_used_quota_delta = 80
            channel_used_quota_delta = 80
            request_count_delta = 1
            client_response_status: object = 200
        elif action == "refund":
            operation_status = "failed"
            billing_final_quota = None
            billing_request_accounted = 1
            frozen_pre_consumed_quota = pre_consumed_quota
            user_quota_delta = pre_consumed_quota
            token_quota_delta = 0 if billing_token_id == 0 else pre_consumed_quota
            user_used_quota_delta = 0
            channel_used_quota_delta = 0
            request_count_delta = 1
            client_response_status = 503
        elif action == "recovery_required":
            operation_status = "recovery_required"
            billing_final_quota = None
            billing_request_accounted = 0
            frozen_pre_consumed_quota = pre_consumed_quota
            user_quota_delta = 0
            token_quota_delta = 0
            user_used_quota_delta = 0
            channel_used_quota_delta = 0
            request_count_delta = 0
            client_response_status = None
        else:
            raise AssertionError(f"unsupported 0042 terminal action: {action}")

        has_response = action != "recovery_required"
        created_at = 7400 + event_counter * 10
        values: dict[str, object] = {
            "billing_event_id": digest(f"billing-event:{label}"),
            "reservation_key": key,
            "operation_id": key,
            "owner_generation": operation_owner_generation,
            "operation_from_status": operation_from_status,
            "operation_status": operation_status,
            "terminal_contract_sha256": digest(f"terminal-contract:{label}"),
            "billing_action": action,
            "billing_owner_generation": billing_owner_generation,
            "billing_from_status": (
                "recovery_required"
                if operation_from_status == "recovery_required"
                else "reserved"
            ),
            "billing_final_quota": billing_final_quota,
            "billing_request_accounted": billing_request_accounted,
            "billing_reason": f"sqlite_{action}",
            "pre_consumed_quota": frozen_pre_consumed_quota,
            "user_quota_delta": user_quota_delta,
            "token_quota_delta": token_quota_delta,
            "user_used_quota_delta": user_used_quota_delta,
            "channel_used_quota_delta": channel_used_quota_delta,
            "request_count_delta": request_count_delta,
            "reconciliation_id": authority["reconciliation_id"],
            "reconciliation_revision": reconciliation_revision,
            "client_response_status": client_response_status,
            "client_response_headers_json": (
                '{"content-type":"application/json"}' if has_response else None
            ),
            "client_response_headers_sha256": (
                digest(f"client-headers:{label}") if has_response else None
            ),
            "client_response_object_key": (
                f"container-client-responses/v1/{key}/"
                f"{operation_owner_generation}/{body_sha256}"
                if has_response
                else None
            ),
            "client_response_object_version": (
                f"r2-client-version:{event_counter}" if has_response else None
            ),
            "client_response_sha256": body_sha256 if has_response else None,
            "client_response_size": 512 if has_response else None,
            "client_response_content_type": (
                "application/json" if has_response else None
            ),
            "outbox_schema_version": 1,
            "outbox_payload_json": f'{{"event":"{label}"}}',
            "outbox_payload_sha256": digest(f"outbox-payload:{label}"),
            "created_at": created_at,
        }
        values.update(overrides)
        return values

    def insert_terminal_event(values: dict[str, object]) -> None:
        conn.execute(
            """
            INSERT INTO relay_container_terminal_events (
              billing_event_id, reservation_key, operation_id,
              owner_generation, operation_from_status, operation_status,
              terminal_contract_sha256,
              billing_action, billing_owner_generation, billing_from_status,
              billing_final_quota, billing_request_accounted, billing_reason,
              pre_consumed_quota, user_quota_delta, token_quota_delta,
              user_used_quota_delta, channel_used_quota_delta,
              request_count_delta,
              reconciliation_id, reconciliation_revision,
              client_response_status, client_response_headers_json,
              client_response_headers_sha256, client_response_object_key,
              client_response_object_version, client_response_sha256,
              client_response_size, client_response_content_type,
              outbox_schema_version, outbox_payload_json,
              outbox_payload_sha256, created_at
            ) VALUES (
              :billing_event_id, :reservation_key, :operation_id,
              :owner_generation, :operation_from_status, :operation_status,
              :terminal_contract_sha256,
              :billing_action, :billing_owner_generation, :billing_from_status,
              :billing_final_quota, :billing_request_accounted, :billing_reason,
              :pre_consumed_quota, :user_quota_delta, :token_quota_delta,
              :user_used_quota_delta, :channel_used_quota_delta,
              :request_count_delta,
              :reconciliation_id, :reconciliation_revision,
              :client_response_status, :client_response_headers_json,
              :client_response_headers_sha256, :client_response_object_key,
              :client_response_object_version, :client_response_sha256,
              :client_response_size, :client_response_content_type,
              :outbox_schema_version, :outbox_payload_json,
              :outbox_payload_sha256, :created_at
            )
            """,
            values,
        )

    insert_authority("0042-settle")
    settle_event = terminal_values("0042-settle", "0042-settle", "settle")
    insert_terminal_event(settle_event)
    settle_snapshot = conn.execute(
        "SELECT billing_action, billing_from_status, billing_final_quota, "
        "pre_consumed_quota, user_quota_delta, token_quota_delta, "
        "user_used_quota_delta, channel_used_quota_delta, request_count_delta "
        "FROM relay_container_terminal_events WHERE billing_event_id = ?",
        (settle_event["billing_event_id"],),
    ).fetchone()
    if settle_snapshot != ("settle", "reserved", 80, 120, 40, 40, 80, 80, 1):
        raise SystemExit(f"0042 settle event did not freeze accounting: {settle_snapshot}")
    if conn.execute(
        "SELECT COUNT(*) FROM relay_container_terminal_outbox_state"
    ).fetchone() != (0,):
        raise SystemExit("0042 terminal event insert must not synthesize outbox state")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_terminal_events SET billing_reason = 'rewritten' "
            "WHERE billing_event_id = ?",
            (settle_event["billing_event_id"],),
        ),
        "0042 terminal events must reject every update",
        "relay container terminal event is append-only",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "DELETE FROM relay_container_terminal_events WHERE billing_event_id = ?",
            (settle_event["billing_event_id"],),
        ),
        "0042 terminal events must reject every delete",
        "relay container terminal event is append-only",
    )

    insert_authority("0042-event-negative")
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-uppercase-event",
                "refund",
                billing_event_id="A" * 64,
            )
        ),
        "0042 terminal event IDs must be lowercase hex",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-invalid-headers",
                "refund",
                client_response_headers_json="not-json",
            )
        ),
        "0042 terminal response headers must be valid JSON objects",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-invalid-response-key",
                "refund",
                client_response_object_key="container-client-responses/v1/wrong",
            )
        ),
        "0042 client response object identity must be exact",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-missing-response-status",
                "refund",
                client_response_status=None,
            )
        ),
        "0042 refund events must contain a complete client response",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-wrong-accounting",
                "refund",
                token_quota_delta=119,
            )
        ),
        "0042 terminal accounting must match the billing token reserve",
        "relay container terminal event authority mismatch",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-text-accounting",
                "refund",
                user_quota_delta="not-an-integer",
            )
        ),
        "0042 terminal accounting must reject text affinity bypasses",
        "relay container terminal event authority mismatch",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-wrong-operation-status",
                "settle",
                operation_status="failed",
            )
        ),
        "0042 settle events must target completed operations",
        "CHECK constraint failed",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-stale-operation-from",
                "refund",
                operation_from_status="prepared",
            )
        ),
        "0042 terminal event guard must match the current operation status",
        "relay container terminal event authority mismatch",
    )
    owner_mismatch = terminal_values(
        "0042-event-negative", "0042-owner-mismatch", "refund"
    )
    owner_mismatch["owner_generation"] = 6
    owner_mismatch["client_response_object_key"] = (
        "container-client-responses/v1/0042-event-negative/6/"
        f"{owner_mismatch['client_response_sha256']}"
    )
    expect_integrity_error(
        lambda: insert_terminal_event(owner_mismatch),
        "0042 terminal event guard must fence operation owner generation",
        "relay container terminal event authority mismatch",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-reconciliation-mismatch",
                "refund",
                reconciliation_id=digest("different-reconciliation"),
            )
        ),
        "0042 terminal event guard must match operation reconciliation identity",
        "relay container terminal event authority mismatch",
    )

    refund_event = terminal_values(
        "0042-event-negative", "0042-valid-refund", "refund"
    )
    insert_terminal_event(refund_event)
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-event-negative",
                "0042-duplicate-operation-terminal",
                "refund",
            )
        ),
        "0042 terminal identity must include and uniquely fence operation from-status",
        "UNIQUE constraint failed",
    )

    insert_authority(
        "0042-billing-status-mismatch",
        operation_status="recovery_required",
        billing_status="reserved",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-billing-status-mismatch",
                "0042-billing-status-mismatch",
                "refund",
                operation_from_status="recovery_required",
            )
        ),
        "0042 terminal event guard must match the exact current billing status",
        "relay container terminal event authority mismatch",
    )

    insert_authority(
        "0042-channel-group-mismatch",
        operation_group="default",
        billing_group="secondary",
    )
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-channel-group-mismatch",
                "0042-channel-group-mismatch",
                "refund",
            )
        ),
        "0042 terminal event guard must match operation and billing channel/group",
        "relay container terminal event authority mismatch",
    )

    insert_authority("0042-tokenless", billing_token_id=0)
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-tokenless",
                "0042-tokenless-invalid",
                "settle",
                token_quota_delta=40,
            )
        ),
        "0042 token_id=0 terminal accounting must freeze a zero token delta",
        "relay container terminal event authority mismatch",
    )
    tokenless_event = terminal_values(
        "0042-tokenless", "0042-tokenless-valid", "settle"
    )
    insert_terminal_event(tokenless_event)
    if conn.execute(
        "SELECT token_quota_delta FROM relay_container_terminal_events "
        "WHERE billing_event_id = ?",
        (tokenless_event["billing_event_id"],),
    ).fetchone() != (0,):
        raise SystemExit("0042 tokenless settlement did not freeze a zero token delta")

    insert_authority("0042-recovery-resolution")
    recovery_event = terminal_values(
        "0042-recovery-resolution",
        "0042-recovery-required",
        "recovery_required",
    )
    insert_terminal_event(recovery_event)
    recovery_accounting = conn.execute(
        "SELECT pre_consumed_quota, user_quota_delta, token_quota_delta, "
        "user_used_quota_delta, channel_used_quota_delta, request_count_delta, "
        "client_response_status FROM relay_container_terminal_events "
        "WHERE billing_event_id = ?",
        (recovery_event["billing_event_id"],),
    ).fetchone()
    if recovery_accounting != (
        int(authorities["0042-recovery-resolution"]["pre_consumed_quota"]),
        0,
        0,
        0,
        0,
        0,
        None,
    ):
        raise SystemExit(
            f"0042 recovery event must freeze zero accounting: {recovery_accounting}"
        )
    conn.execute(
        """
        UPDATE relay_container_operations
        SET status = 'recovery_required', response_status = 202,
            response_code = 'container_execution_ambiguous', updated_at = 7600
        WHERE reservation_key = '0042-recovery-resolution'
        """
    )
    conn.execute(
        """
        UPDATE relay_billing_reservations
        SET status = 'recovery_required', owner_generation = owner_generation + 1,
            finalization_reason = 'container_execution_ambiguous',
            updated_at = 7600, recovery_required_at = 7600
        WHERE reservation_key = '0042-recovery-resolution'
        """
    )
    authorities["0042-recovery-resolution"]["billing_owner_generation"] = 6
    expect_integrity_error(
        lambda: insert_terminal_event(
            terminal_values(
                "0042-recovery-resolution",
                "0042-recovery-duplicate-revision",
                "settle",
                operation_from_status="recovery_required",
                reconciliation_revision=1,
            )
        ),
        "0042 recovery resolution must advance the reconciliation revision",
        "CHECK constraint failed",
    )
    recovered_event = terminal_values(
        "0042-recovery-resolution",
        "0042-recovered-settle",
        "settle",
        operation_from_status="recovery_required",
        reconciliation_revision=2,
    )
    insert_terminal_event(recovered_event)
    recovered_events = conn.execute(
        "SELECT operation_from_status, operation_status, billing_from_status, "
        "reconciliation_revision FROM relay_container_terminal_events "
        "WHERE operation_id = '0042-recovery-resolution' "
        "ORDER BY reconciliation_revision"
    ).fetchall()
    if recovered_events != [
        ("dispatched", "recovery_required", "reserved", 1),
        ("recovery_required", "completed", "recovery_required", 2),
    ]:
        raise SystemExit(
            "0042 recovery authorization must allow a second from-status event: "
            f"{recovered_events}"
        )

    def insert_outbox(
        event: dict[str, object],
        **overrides: object,
    ) -> None:
        created_at = int(event["created_at"])
        values: dict[str, object] = {
            "billing_event_id": event["billing_event_id"],
            "status": "pending",
            "delivery_generation": 0,
            "delivery_attempt_count": 0,
            "lease_expires_at": 0,
            "available_at": created_at,
            "delivered_at": 0,
            "last_error": "",
            "created_at": created_at,
            "updated_at": created_at,
        }
        values.update(overrides)
        conn.execute(
            """
            INSERT INTO relay_container_terminal_outbox_state (
              billing_event_id, status,
              delivery_generation, delivery_attempt_count,
              lease_expires_at, available_at, delivered_at, last_error,
              created_at, updated_at
            ) VALUES (
              :billing_event_id, :status,
              :delivery_generation, :delivery_attempt_count,
              :lease_expires_at, :available_at, :delivered_at, :last_error,
              :created_at, :updated_at
            )
            """,
            values,
        )

    missing_event = {
        "billing_event_id": digest("0042-missing-outbox-event"),
        "created_at": 8000,
    }
    expect_integrity_error(
        lambda: insert_outbox(missing_event),
        "0042 outbox state must reference an immutable terminal event",
        "relay container terminal outbox initial state is invalid",
    )
    expect_integrity_error(
        lambda: insert_outbox(
            settle_event,
            status="leased",
            delivery_generation=1,
            delivery_attempt_count=1,
            lease_expires_at=int(settle_event["created_at"]) + 100,
        ),
        "0042 outbox rows must begin in the exact pending state",
        "relay container terminal outbox initial state is invalid",
    )
    expect_integrity_error(
        lambda: insert_outbox(
            settle_event,
            available_at="not-an-integer",
        ),
        "0042 outbox timestamps must reject text affinity bypasses",
        "relay container terminal outbox initial state is invalid",
    )

    insert_outbox(settle_event)
    settle_event_id = str(settle_event["billing_event_id"])
    settle_created_at = int(settle_event["created_at"])
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_terminal_outbox_state
            SET status = 'delivered', delivery_generation = 1,
                delivery_attempt_count = 1, delivered_at = ?, updated_at = ?
            WHERE billing_event_id = ?
            """,
            (settle_created_at + 10, settle_created_at + 10, settle_event_id),
        ),
        "0042 outbox must reject pending-to-delivered shortcuts",
        "relay container terminal outbox transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_terminal_outbox_state "
            "SET billing_event_id = ? WHERE billing_event_id = ?",
            (digest("0042-rewritten-outbox-event"), settle_event_id),
        ),
        "0042 outbox identity must be immutable",
    )
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET status = 'leased', delivery_generation = 1,
            delivery_attempt_count = 1, lease_expires_at = ?, updated_at = ?
        WHERE billing_event_id = ?
        """,
        (settle_created_at + 200, settle_created_at + 20, settle_event_id),
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_terminal_outbox_state
            SET delivery_generation = 2, delivery_attempt_count = 2,
                lease_expires_at = ?, updated_at = ?
            WHERE billing_event_id = ?
            """,
            (settle_created_at + 300, settle_created_at + 30, settle_event_id),
        ),
        "0042 outbox must reject a generation takeover before lease expiry",
        "relay container terminal outbox transition is invalid",
    )
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET lease_expires_at = ?, updated_at = ?
        WHERE billing_event_id = ?
        """,
        (settle_created_at + 300, settle_created_at + 30, settle_event_id),
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_terminal_outbox_state
            SET lease_expires_at = ?, updated_at = ?
            WHERE billing_event_id = ?
            """,
            (settle_created_at + 500, settle_created_at + 350, settle_event_id),
        ),
        "0042 outbox must reject same-generation renewal after lease expiry",
        "relay container terminal outbox transition is invalid",
    )
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET status = 'pending', lease_expires_at = 0,
            available_at = ?, last_error = 'temporary queue failure', updated_at = ?
        WHERE billing_event_id = ?
        """,
        (settle_created_at + 50, settle_created_at + 40, settle_event_id),
    )
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET status = 'leased', delivery_generation = 2,
            delivery_attempt_count = 2, lease_expires_at = ?,
            last_error = '', updated_at = ?
        WHERE billing_event_id = ?
        """,
        (settle_created_at + 400, settle_created_at + 60, settle_event_id),
    )
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET status = 'delivered', lease_expires_at = 0,
            delivered_at = ?, updated_at = ?
        WHERE billing_event_id = ?
        """,
        (settle_created_at + 70, settle_created_at + 70, settle_event_id),
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_terminal_outbox_state
            SET delivered_at = ?, updated_at = ?
            WHERE billing_event_id = ?
            """,
            (settle_created_at + 80, settle_created_at + 80, settle_event_id),
        ),
        "0042 delivered outbox rows must be terminal",
        "relay container terminal outbox transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "DELETE FROM relay_container_terminal_outbox_state "
            "WHERE billing_event_id = ?",
            (settle_event_id,),
        ),
        "0042 outbox state must not be deleted",
        "relay container terminal outbox state cannot be deleted",
    )

    insert_outbox(refund_event)
    refund_event_id = str(refund_event["billing_event_id"])
    refund_created_at = int(refund_event["created_at"])
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET status = 'leased', delivery_generation = 1,
            delivery_attempt_count = 1, lease_expires_at = ?, updated_at = ?
        WHERE billing_event_id = ?
        """,
        (refund_created_at + 200, refund_created_at + 10, refund_event_id),
    )
    conn.execute(
        """
        UPDATE relay_container_terminal_outbox_state
        SET status = 'dead_letter', lease_expires_at = 0,
            last_error = 'permanent queue failure', updated_at = ?
        WHERE billing_event_id = ?
        """,
        (refund_created_at + 20, refund_event_id),
    )
    final_outbox_states = conn.execute(
        "SELECT billing_event_id, status, delivery_generation, "
        "delivery_attempt_count FROM relay_container_terminal_outbox_state "
        "WHERE billing_event_id IN (?, ?) ORDER BY billing_event_id",
        (settle_event_id, refund_event_id),
    ).fetchall()
    expected_outbox_states = sorted(
        [
            (settle_event_id, "delivered", 2, 2),
            (refund_event_id, "dead_letter", 1, 1),
        ]
    )
    if final_outbox_states != expected_outbox_states:
        raise SystemExit(f"0042 outbox lifecycle did not persist: {final_outbox_states}")


def verify_relay_container_reconciliation_observer(
    conn: sqlite3.Connection,
) -> None:
    required_triggers = (
        "relay_container_reconciliation_observation_insert_guard",
        "relay_container_reconciliation_observation_identity_immutable_guard",
        "relay_container_reconciliation_observation_lifecycle_guard",
        "relay_container_reconciliation_observation_delete_guard",
        "relay_container_reconciliation_cursor_identity_immutable_guard",
        "relay_container_reconciliation_cursor_lifecycle_guard",
        "relay_container_reconciliation_cursor_delete_guard",
    )
    for trigger in required_triggers:
        if not trigger_exists(conn, trigger):
            raise SystemExit(f"0043 reconciliation observer trigger missing: {trigger}")

    observation_table_sql = sqlite_object_sql(
        conn, "table", "relay_container_reconciliation_observations"
    )
    for fragment in (
        "operation_id TEXT PRIMARY KEY NOT NULL",
        "reservation_key TEXT NOT NULL UNIQUE",
        "status IN ('pending', 'leased', 'retry', 'converged', 'dead_letter')",
        "claim_generation = attempt_count",
        "consecutive_failures <= attempt_count",
        "claim_lease_expires_at > updated_at",
        "last_observed_at BETWEEN first_observed_at AND updated_at",
        "reconciliation_id NOT GLOB '*[^0-9a-f]*'",
        "claim_owner NOT GLOB '*[^0-9a-f]*'",
        "last_class IN (",
        "last_error_code NOT GLOB '*[^a-z0-9_:-]*'",
        "dead_letter_reason NOT GLOB '*[^a-z0-9_:-]*'",
        "REFERENCES relay_container_operations(operation_id)",
    ):
        if observation_table_sql is None or fragment not in observation_table_sql:
            raise SystemExit(f"0043 reconciliation observation schema missing: {fragment}")

    expected_classes = (
        "",
        "converged_replayable",
        "prepared_do_absent",
        "dispatched_do_absent",
        "pending_do_claimed",
        "pending_do_running",
        "d1_lagging_dispatch",
        "d1_lagging_terminal",
        "recovery_do_absent",
        "recovery_pending",
        "recovery_resolvable",
        "terminal_do_absent",
        "terminal_conflict",
        "terminal_response_missing",
        "terminal_response_divergent",
        "response_r2_orphan",
        "legacy_terminal_without_receipt",
        "store_unavailable",
        "contract_violation",
    )
    class_marker = "last_class IN ("
    class_start = observation_table_sql.index(class_marker) + len(class_marker)
    class_end = observation_table_sql.index(")", class_start)
    actual_classes = tuple(
        value.strip().strip("'")
        for value in observation_table_sql[class_start:class_end].split(",")
    )
    if actual_classes != expected_classes:
        raise SystemExit(
            f"0043 reconciliation class allowlist mismatch: {actual_classes}"
        )

    insert_guard_sql = sqlite_object_sql(
        conn,
        "trigger",
        "relay_container_reconciliation_observation_insert_guard",
    )
    for fragment in (
        "operation.operation_id = NEW.operation_id",
        "operation.reservation_key = NEW.reservation_key",
        "operation.created_at = NEW.operation_created_at",
        "operation.owner_generation = NEW.owner_generation",
        "operation.reconciliation_id = NEW.reconciliation_id",
    ):
        if insert_guard_sql is None or fragment not in insert_guard_sql:
            raise SystemExit(f"0043 reconciliation identity join missing: {fragment}")

    lifecycle_sql = sqlite_object_sql(
        conn,
        "trigger",
        "relay_container_reconciliation_observation_lifecycle_guard",
    )
    for fragment in (
        "OLD.status IN ('pending', 'retry')",
        "OLD.status = 'leased'",
        "OLD.claim_lease_expires_at <= NEW.updated_at",
        "OLD.claim_lease_expires_at > NEW.updated_at",
        "NEW.status = 'retry'",
        "NEW.status = 'converged'",
        "NEW.status = 'dead_letter'",
        "OLD.status NOT IN ('converged', 'dead_letter')",
        "NEW.claim_generation = OLD.claim_generation + 1",
        "NEW.updated_at >= OLD.updated_at",
    ):
        if lifecycle_sql is None or fragment not in lifecycle_sql:
            raise SystemExit(f"0043 reconciliation lifecycle missing: {fragment}")

    cursor_table_sql = sqlite_object_sql(
        conn, "table", "relay_container_reconciliation_cursor"
    )
    for fragment in (
        "cursor_name = 'operation_observer_v1'",
        "typeof(last_created_at) = 'integer'",
        "typeof(round_high_created_at) = 'integer'",
        "typeof(scan_generation) = 'integer'",
        "typeof(run_generation) = 'integer'",
        "run_owner NOT GLOB '*[^0-9a-f]*'",
        "typeof(run_lease_expires_at) = 'integer'",
        "typeof(last_started_at) = 'integer'",
        "typeof(last_completed_at) = 'integer'",
        "typeof(last_success_at) = 'integer'",
        "last_error_code NOT GLOB '*[^a-z0-9_:-]*'",
        "scan_generation = 0",
        "scan_generation > 0",
    ):
        if cursor_table_sql is None or fragment not in cursor_table_sql:
            raise SystemExit(f"0043 reconciliation cursor schema missing: {fragment}")

    cursor_lifecycle_sql = sqlite_object_sql(
        conn, "trigger", "relay_container_reconciliation_cursor_lifecycle_guard"
    )
    for fragment in (
        "NEW.run_generation = OLD.run_generation + 1",
        "OLD.run_lease_expires_at <= NEW.updated_at",
        "OLD.run_lease_expires_at > NEW.updated_at",
        "NEW.last_started_at = NEW.updated_at",
        "NEW.last_completed_at = NEW.updated_at",
        "NEW.last_success_at = NEW.updated_at",
        "NEW.last_success_at = OLD.last_success_at",
        "NEW.last_error_code = ''",
        "length(NEW.last_error_code) > 0",
    ):
        if cursor_lifecycle_sql is None or fragment not in cursor_lifecycle_sql:
            raise SystemExit(f"0043 observer run lifecycle missing: {fragment}")

    partial_indexes = {
        "idx_relay_container_reconciliation_observations_due": (
            "WHERE status IN ('pending', 'retry')"
        ),
        "idx_relay_container_reconciliation_observations_lease": (
            "WHERE status = 'leased'"
        ),
        "idx_relay_container_reconciliation_observations_class": (
            "WHERE last_class <> ''"
        ),
    }
    for index_name, predicate in partial_indexes.items():
        index_sql = sqlite_object_sql(conn, "index", index_name)
        if index_sql is None or predicate not in index_sql:
            raise SystemExit(f"0043 reconciliation partial index missing: {index_name}")

    if conn.execute(
        "SELECT COUNT(*) FROM relay_container_reconciliation_observations"
    ).fetchone() != (0,):
        raise SystemExit("0043 observer expand must not backfill observations")
    cursor = conn.execute(
        "SELECT cursor_name, last_created_at, last_reservation_key, "
        "round_high_created_at, round_high_reservation_key, scan_generation, "
        "run_generation, run_owner, run_lease_expires_at, last_started_at, "
        "last_completed_at, last_success_at, last_error_code, updated_at "
        "FROM relay_container_reconciliation_cursor"
    ).fetchall()
    if cursor != [
        ("operation_observer_v1", 0, "", 0, "", 0, 0, "", 0, 0, 0, 0, "", 0)
    ]:
        raise SystemExit(f"0043 observer cursor seed is not default-lazy: {cursor}")

    expect_integrity_error(
        lambda: conn.execute(
            "INSERT INTO relay_container_reconciliation_cursor VALUES "
            "('another_observer', 0, '', 0, '', 0, 0, '', 0, 0, 0, 0, '', 0)"
        ),
        "0043 cursor must reject every non-singleton identity",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET round_high_created_at = 12000, "
            "round_high_reservation_key = '0043-cursor-z', "
            "scan_generation = 1, updated_at = 1 "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 cursor must not advance without a global run lease",
        "relay container reconciliation cursor transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET run_generation = 1, run_owner = NULL, "
            "run_lease_expires_at = 100, last_started_at = 10, updated_at = 10 "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 run owner must reject NULL",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET run_generation = 'one', "
            "run_owner = '11111111111111111111111111111111', "
            "run_lease_expires_at = 100, last_started_at = 10, updated_at = 10 "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 run generation must reject text affinity bypasses",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET run_generation = 1, "
            "run_owner = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', "
            "run_lease_expires_at = 100, last_started_at = 10, updated_at = 10 "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 run owners must be lowercase hex tokens",
    )

    first_run_owner = "1" * 32
    if conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_generation = 1, run_owner = ?, run_lease_expires_at = 100,
            last_started_at = 10, updated_at = 10
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 0 AND run_owner = ''
        """,
        (first_run_owner,),
    ).rowcount != 1:
        raise SystemExit("0043 initial global observer run lease was not acquired")

    stale_progress = conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET round_high_created_at = 12000,
            round_high_reservation_key = '0043-cursor-z',
            scan_generation = 1, updated_at = 10
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 1 AND run_owner = ?
        """,
        ("f" * 32,),
    ).rowcount
    if stale_progress != 0:
        raise SystemExit("0043 stale run owner advanced the cursor")
    if conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET round_high_created_at = 12000,
            round_high_reservation_key = '0043-cursor-z',
            scan_generation = 1, updated_at = 10
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 1 AND run_owner = ?
          AND run_lease_expires_at > 10
        """,
        (first_run_owner,),
    ).rowcount != 1:
        raise SystemExit("0043 active run owner did not begin a cursor round")
    if conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET last_created_at = 11000,
            last_reservation_key = '0043-cursor-a', updated_at = 11
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 1 AND run_owner = ?
          AND run_lease_expires_at > 11
        """,
        (first_run_owner,),
    ).rowcount != 1:
        raise SystemExit("0043 active run owner did not advance the cursor")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET last_created_at = 10000, last_reservation_key = '0043-cursor-a', "
            "updated_at = 12 WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 cursor position must not move backward within a run",
        "relay container reconciliation cursor transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET run_generation = 2, "
            "run_owner = '22222222222222222222222222222222', "
            "run_lease_expires_at = 110, last_started_at = 20, updated_at = 20 "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 active global run lease must not be taken over before expiry",
        "relay container reconciliation cursor transition is invalid",
    )
    if conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_owner = '', run_lease_expires_at = 0,
            last_completed_at = 20, last_success_at = 20,
            last_error_code = '', updated_at = 20
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 1 AND run_owner = ?
          AND run_lease_expires_at > 20
        """,
        (first_run_owner,),
    ).rowcount != 1:
        raise SystemExit("0043 successful observer run report was not persisted")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET last_created_at = 11500, last_reservation_key = '0043-cursor-b', "
            "updated_at = 20 WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 completed run must not advance cursor state",
        "relay container reconciliation cursor transition is invalid",
    )

    second_run_owner = "2" * 32
    conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_generation = 2, run_owner = ?, run_lease_expires_at = 30,
            last_started_at = 21, last_error_code = '', updated_at = 21
        WHERE cursor_name = 'operation_observer_v1'
        """,
        (second_run_owner,),
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET last_created_at = 11500, last_reservation_key = '0043-cursor-b', "
            "updated_at = 30 WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 expired run owner must not advance cursor state",
        "relay container reconciliation cursor transition is invalid",
    )
    third_run_owner = "3" * 32
    conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_generation = 3, run_owner = ?, run_lease_expires_at = 40,
            last_started_at = 30, last_error_code = '', updated_at = 30
        WHERE cursor_name = 'operation_observer_v1'
        """,
        (third_run_owner,),
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_owner = '', run_lease_expires_at = 0,
            last_completed_at = 35, last_success_at = 20,
            last_error_code = 'store_unavailable', updated_at = 35
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 3 AND run_owner = ?
        """,
        (third_run_owner,),
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_cursor "
            "SET run_generation = 4, "
            "run_owner = '44444444444444444444444444444444', "
            "run_lease_expires_at = 50, last_started_at = 34, "
            "last_error_code = '', updated_at = 36 "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 run start timestamps must not precede the last completion",
    )
    fourth_run_owner = "4" * 32
    conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_generation = 4, run_owner = ?, run_lease_expires_at = 50,
            last_started_at = 36, last_error_code = '', updated_at = 36
        WHERE cursor_name = 'operation_observer_v1'
        """,
        (fourth_run_owner,),
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_cursor
        SET run_owner = '', run_lease_expires_at = 0,
            last_completed_at = 37, last_success_at = 37,
            last_error_code = '', updated_at = 37
        WHERE cursor_name = 'operation_observer_v1'
          AND run_generation = 4 AND run_owner = ?
        """,
        (fourth_run_owner,),
    )
    run_report = conn.execute(
        "SELECT run_generation, run_owner, run_lease_expires_at, "
        "last_started_at, last_completed_at, last_success_at, last_error_code "
        "FROM relay_container_reconciliation_cursor "
        "WHERE cursor_name = 'operation_observer_v1'"
    ).fetchone()
    if run_report != (4, "", 0, 36, 37, 37, ""):
        raise SystemExit(f"0043 observer run report did not persist: {run_report}")
    expect_integrity_error(
        lambda: conn.execute(
            "DELETE FROM relay_container_reconciliation_cursor "
            "WHERE cursor_name = 'operation_observer_v1'"
        ),
        "0043 cursor must not be deleted",
        "relay container reconciliation cursor cannot be deleted",
    )

    operations: dict[str, dict[str, object]] = {}

    def digest(label: str) -> str:
        return hashlib.sha256(label.encode("utf-8")).hexdigest()

    def insert_operation(
        key: str,
        created_at: int,
        owner_generation: int,
        *,
        legacy_identity: bool = False,
    ) -> None:
        input_sha256 = digest(f"input:{key}")
        values: dict[str, object] = {
            "reservation_key": key,
            "operation_id": key,
            "owner_generation": owner_generation,
            "owner_lease_expires_at": created_at + 3000,
            "channel_id": 43,
            "selected_group": "default",
            "operation_kind": "relay_chat",
            "provider_operation_id": f"provider:{key}",
            "admission_sha256": digest(f"admission:{key}"),
            "protocol_version": 1,
            "shard_contract_version": 1,
            "ring_generation": 8,
            "shard_count": 8,
            "shard_index": 3,
            "instance_name": "cinatoken-relay-shard-v1-0003",
            "execution_deadline_at": created_at + 2000,
            "input_mode": "r2",
            "input_object_key": (
                f"container-inputs/v1/{key}/{owner_generation}/{input_sha256}"
            ),
            "input_object_version": "r2-version-0043",
            "input_sha256": input_sha256,
            "input_size": 256,
            "input_content_type": "application/json",
            "trace_id": f"trace:{key}",
            "client_idempotency_hmac_sha256": (
                "" if legacy_identity else digest(f"client:{key}")
            ),
            "client_request_sha256": (
                "" if legacy_identity else digest(f"request:{key}")
            ),
            "reconciliation_id": (
                "" if legacy_identity else digest(f"reconciliation:{key}")
            ),
            "created_at": created_at,
            "updated_at": created_at,
        }
        conn.execute(
            """
            INSERT INTO relay_container_operations (
              reservation_key, operation_id,
              owner_generation, owner_lease_expires_at, channel_id, selected_group,
              operation_kind, provider_operation_id, admission_sha256,
              protocol_version, shard_contract_version,
              ring_generation, shard_count, shard_index, instance_name,
              execution_deadline_at, input_mode, input_object_key,
              input_object_version, input_sha256, input_size,
              input_content_type, trace_id,
              client_idempotency_hmac_sha256, client_request_sha256,
              reconciliation_id, created_at, updated_at
            ) VALUES (
              :reservation_key, :operation_id,
              :owner_generation, :owner_lease_expires_at, :channel_id, :selected_group,
              :operation_kind, :provider_operation_id, :admission_sha256,
              :protocol_version, :shard_contract_version,
              :ring_generation, :shard_count, :shard_index, :instance_name,
              :execution_deadline_at, :input_mode, :input_object_key,
              :input_object_version, :input_sha256, :input_size,
              :input_content_type, :trace_id,
              :client_idempotency_hmac_sha256, :client_request_sha256,
              :reconciliation_id, :created_at, :updated_at
            )
            """,
            values,
        )
        operations[key] = values

    def observation_values(
        key: str,
        observed_at: int,
        recovery_deadline_at: int,
        **overrides: object,
    ) -> dict[str, object]:
        operation = operations[key]
        values: dict[str, object] = {
            "operation_id": key,
            "reservation_key": key,
            "operation_created_at": operation["created_at"],
            "owner_generation": operation["owner_generation"],
            "reconciliation_id": operation["reconciliation_id"],
            "status": "pending",
            "claim_generation": 0,
            "claim_owner": "",
            "claim_lease_expires_at": 0,
            "available_at": observed_at,
            "attempt_count": 0,
            "consecutive_failures": 0,
            "first_observed_at": 0,
            "last_attempt_at": 0,
            "last_observed_at": 0,
            "last_class": "",
            "last_error_code": "",
            "recovery_deadline_at": recovery_deadline_at,
            "converged_at": 0,
            "dead_lettered_at": 0,
            "dead_letter_reason": "",
            "created_at": observed_at,
            "updated_at": observed_at,
        }
        values.update(overrides)
        return values

    def insert_observation(values: dict[str, object]) -> None:
        conn.execute(
            """
            INSERT INTO relay_container_reconciliation_observations (
              operation_id, reservation_key, operation_created_at,
              owner_generation, reconciliation_id, status,
              claim_generation, claim_owner, claim_lease_expires_at,
              available_at, attempt_count, consecutive_failures,
              first_observed_at, last_attempt_at, last_observed_at,
              last_class, last_error_code, recovery_deadline_at,
              converged_at, dead_lettered_at, dead_letter_reason,
              created_at, updated_at
            ) VALUES (
              :operation_id, :reservation_key, :operation_created_at,
              :owner_generation, :reconciliation_id, :status,
              :claim_generation, :claim_owner, :claim_lease_expires_at,
              :available_at, :attempt_count, :consecutive_failures,
              :first_observed_at, :last_attempt_at, :last_observed_at,
              :last_class, :last_error_code, :recovery_deadline_at,
              :converged_at, :dead_lettered_at, :dead_letter_reason,
              :created_at, :updated_at
            )
            """,
            values,
        )

    def insert_default_observation(values: dict[str, object]) -> None:
        conn.execute(
            """
            INSERT INTO relay_container_reconciliation_observations (
              operation_id, reservation_key, operation_created_at,
              owner_generation, reconciliation_id, status, available_at,
              recovery_deadline_at, created_at, updated_at
            ) VALUES (
              :operation_id, :reservation_key, :operation_created_at,
              :owner_generation, :reconciliation_id, :status, :available_at,
              :recovery_deadline_at, :created_at, :updated_at
            )
            """,
            values,
        )

    insert_operation("0043-observation", 20000, 3)
    invalid_identity = observation_values("0043-observation", 20100, 22000)
    invalid_identity["owner_generation"] = 4
    expect_integrity_error(
        lambda: insert_observation(invalid_identity),
        "0043 observations must exactly join the operation owner identity",
        "relay container reconciliation observation identity or initial state is invalid",
    )
    invalid_created_at = observation_values("0043-observation", 20100, 22000)
    invalid_created_at["operation_created_at"] = 19999
    expect_integrity_error(
        lambda: insert_observation(invalid_created_at),
        "0043 observations must exactly join the operation creation identity",
        "relay container reconciliation observation identity or initial state is invalid",
    )
    invalid_reconciliation = observation_values("0043-observation", 20100, 22000)
    invalid_reconciliation["reconciliation_id"] = "A" * 64
    expect_integrity_error(
        lambda: insert_observation(invalid_reconciliation),
        "0043 reconciliation identity must be exact lowercase hex",
    )
    invalid_initial = observation_values(
        "0043-observation",
        20100,
        22000,
        status="leased",
        claim_generation=1,
        claim_owner="1" * 32,
        claim_lease_expires_at=20500,
        available_at=0,
        attempt_count=1,
        first_observed_at=20100,
        last_attempt_at=20100,
    )
    expect_integrity_error(
        lambda: insert_observation(invalid_initial),
        "0043 observations must begin in the exact pending shape",
        "relay container reconciliation observation identity or initial state is invalid",
    )
    invalid_type = observation_values(
        "0043-observation", 20100, 22000, attempt_count="one"
    )
    expect_integrity_error(
        lambda: insert_observation(invalid_type),
        "0043 observation counters must reject text affinity bypasses",
    )
    insert_default_observation(
        observation_values("0043-observation", 20100, 22000)
    )
    pending_defaults = conn.execute(
        "SELECT claim_generation, claim_owner, claim_lease_expires_at, "
        "attempt_count, consecutive_failures, first_observed_at, "
        "last_attempt_at, last_observed_at, last_class, last_error_code, "
        "converged_at, dead_lettered_at, dead_letter_reason "
        "FROM relay_container_reconciliation_observations "
        "WHERE operation_id = '0043-observation'"
    ).fetchone()
    if pending_defaults != (0, "", 0, 0, 0, 0, 0, 0, "", "", 0, 0, ""):
        raise SystemExit(f"0043 pending defaults are not inert: {pending_defaults}")

    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'leased', claim_generation = 1,
                claim_owner = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                claim_lease_expires_at = 20500, available_at = 0,
                attempt_count = 1, first_observed_at = 20150,
                last_attempt_at = 20150, updated_at = 20150
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 lease owners must be lowercase tokens",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'leased', claim_generation = 1,
                claim_owner = NULL, claim_lease_expires_at = 20500,
                available_at = 0, attempt_count = 1,
                first_observed_at = 20150, last_attempt_at = 20150,
                updated_at = 20150
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 lease owner shape must reject NULL",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'converged', claim_generation = 1,
                available_at = 0, attempt_count = 1,
                consecutive_failures = 0, first_observed_at = 20150,
                last_attempt_at = 20150,
                last_observed_at = 20150, last_class = 'converged_replayable',
                last_error_code = '',
                converged_at = 20150, updated_at = 20150
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 pending observations must not skip directly to terminal",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_observations "
            "SET owner_generation = 4 WHERE operation_id = '0043-observation'"
        ),
        "0043 observation identity must be immutable",
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET status = 'leased', claim_generation = 1,
            claim_owner = '11111111111111111111111111111111',
            claim_lease_expires_at = 20500, available_at = 0,
            attempt_count = 1, first_observed_at = 20100,
            last_attempt_at = 20100, updated_at = 20100
        WHERE operation_id = '0043-observation'
        """
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET claim_lease_expires_at = 20600,
                last_attempt_at = 20300, updated_at = 20300
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 active leases must not be renewed in place",
        "relay container reconciliation observation transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET claim_generation = 2,
                claim_owner = '22222222222222222222222222222222',
                claim_lease_expires_at = 20700, attempt_count = 2,
                last_attempt_at = 20400, updated_at = 20400
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 active leases must not be taken over before expiry",
        "relay container reconciliation observation transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'retry', claim_owner = '',
                claim_lease_expires_at = 0, available_at = 20600,
                consecutive_failures = 1, last_observed_at = 20500,
                last_class = 'store_unavailable',
                last_error_code = 'lease_expired', updated_at = 20500
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 expired lease owners must not record an outcome",
        "relay container reconciliation observation transition is invalid",
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET claim_generation = 2,
            claim_owner = '22222222222222222222222222222222',
            claim_lease_expires_at = 20800, attempt_count = 2,
            last_attempt_at = 20500, updated_at = 20500
        WHERE operation_id = '0043-observation'
        """
    )
    takeover = conn.execute(
        "SELECT status, claim_generation, claim_owner, attempt_count, "
        "consecutive_failures, last_attempt_at FROM "
        "relay_container_reconciliation_observations "
        "WHERE operation_id = '0043-observation'"
    ).fetchone()
    if takeover != ("leased", 2, "2" * 32, 2, 0, 20500):
        raise SystemExit(f"0043 expired lease takeover did not persist: {takeover}")

    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'retry', claim_owner = '',
                claim_lease_expires_at = 0, available_at = 20650,
                consecutive_failures = 1, last_observed_at = 20600,
                last_class = 'Store_Unavailable',
                last_error_code = 'controller_timeout', updated_at = 20600
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 observation classes must be lowercase tokens",
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'retry', claim_owner = '',
                claim_lease_expires_at = 0, available_at = 20650,
                consecutive_failures = 1, last_observed_at = 20600,
                last_class = 'unknown_divergence',
                last_error_code = 'controller_timeout', updated_at = 20600
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 observation classes must reject unrecognized lowercase tokens",
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET status = 'retry', claim_owner = '',
            claim_lease_expires_at = 0, available_at = 20650,
            consecutive_failures = 1, last_observed_at = 20600,
            last_class = 'store_unavailable',
            last_error_code = 'controller_timeout', updated_at = 20600
        WHERE operation_id = '0043-observation'
        """
    )
    retry = conn.execute(
        "SELECT status, claim_generation, claim_owner, available_at, "
        "attempt_count, consecutive_failures, last_class, last_error_code "
        "FROM relay_container_reconciliation_observations "
        "WHERE operation_id = '0043-observation'"
    ).fetchone()
    if retry != (
        "retry",
        2,
        "",
        20650,
        2,
        1,
        "store_unavailable",
        "controller_timeout",
    ):
        raise SystemExit(f"0043 retry transition did not persist: {retry}")
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'leased', claim_generation = 3,
                claim_owner = '33333333333333333333333333333333',
                claim_lease_expires_at = 20900, available_at = 0,
                attempt_count = 3, last_attempt_at = 20625, updated_at = 20625
            WHERE operation_id = '0043-observation'
            """
        ),
        "0043 retry observations must not be leased before available_at",
        "relay container reconciliation observation transition is invalid",
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET status = 'leased', claim_generation = 3,
            claim_owner = '33333333333333333333333333333333',
            claim_lease_expires_at = 21000, available_at = 0,
            attempt_count = 3, last_attempt_at = 20650, updated_at = 20650
        WHERE operation_id = '0043-observation'
        """
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET status = 'converged', claim_owner = '',
            claim_lease_expires_at = 0, available_at = 0,
            consecutive_failures = 0, last_observed_at = 20900,
            last_class = 'converged_replayable', last_error_code = '',
            converged_at = 20900, updated_at = 20900
        WHERE operation_id = '0043-observation'
        """
    )
    converged = conn.execute(
        "SELECT status, claim_generation, attempt_count, consecutive_failures, "
        "last_class, last_error_code, converged_at, dead_lettered_at "
        "FROM relay_container_reconciliation_observations "
        "WHERE operation_id = '0043-observation'"
    ).fetchone()
    if converged != (
        "converged",
        3,
        3,
        0,
        "converged_replayable",
        "",
        20900,
        0,
    ):
        raise SystemExit(f"0043 converged transition did not persist: {converged}")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_observations "
            "SET status = status WHERE operation_id = '0043-observation'"
        ),
        "0043 converged observations must reject every update",
        "relay container reconciliation observation transition is invalid",
    )
    expect_integrity_error(
        lambda: conn.execute(
            "DELETE FROM relay_container_reconciliation_observations "
            "WHERE operation_id = '0043-observation'"
        ),
        "0043 observations must not be deleted",
        "relay container reconciliation observation cannot be deleted",
    )

    insert_operation(
        "0043-legacy-observation", 21000, 3, legacy_identity=True
    )
    insert_default_observation(
        observation_values("0043-legacy-observation", 21100, 23000)
    )
    legacy_identity = conn.execute(
        "SELECT reconciliation_id, status FROM "
        "relay_container_reconciliation_observations "
        "WHERE operation_id = '0043-legacy-observation'"
    ).fetchone()
    if legacy_identity != ("", "pending"):
        raise SystemExit(
            f"0043 observer rejected exact 0042 legacy identity: {legacy_identity}"
        )

    insert_operation("0043-dead-letter", 23000, 4)
    insert_default_observation(
        observation_values("0043-dead-letter", 23100, 25000)
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET status = 'leased', claim_generation = 1,
            claim_owner = 'dddddddddddddddddddddddddddddddd',
            claim_lease_expires_at = 23500, available_at = 0,
            attempt_count = 1, first_observed_at = 23200,
            last_attempt_at = 23200, updated_at = 23200
        WHERE operation_id = '0043-dead-letter'
        """
    )
    expect_integrity_error(
        lambda: conn.execute(
            """
            UPDATE relay_container_reconciliation_observations
            SET status = 'dead_letter', claim_owner = '',
                claim_lease_expires_at = 0, available_at = 0,
                last_observed_at = 23200, last_class = 'contract_violation',
                last_error_code = 'invalid_manifest',
                dead_lettered_at = 23200,
                dead_letter_reason = 'Operator_Review', updated_at = 23200
            WHERE operation_id = '0043-dead-letter'
            """
        ),
        "0043 dead-letter reasons must be lowercase tokens",
    )
    conn.execute(
        """
        UPDATE relay_container_reconciliation_observations
        SET status = 'dead_letter', claim_owner = '',
            claim_lease_expires_at = 0, available_at = 0,
            last_observed_at = 23200, last_class = 'contract_violation',
            last_error_code = 'invalid_manifest',
            dead_lettered_at = 23200,
            dead_letter_reason = 'operator_review_required', updated_at = 23200
        WHERE operation_id = '0043-dead-letter'
        """
    )
    dead_letter = conn.execute(
        "SELECT status, claim_generation, attempt_count, consecutive_failures, "
        "last_class, last_error_code, dead_lettered_at, dead_letter_reason "
        "FROM relay_container_reconciliation_observations "
        "WHERE operation_id = '0043-dead-letter'"
    ).fetchone()
    if dead_letter != (
        "dead_letter",
        1,
        1,
        0,
        "contract_violation",
        "invalid_manifest",
        23200,
        "operator_review_required",
    ):
        raise SystemExit(f"0043 dead-letter transition did not persist: {dead_letter}")
    expect_integrity_error(
        lambda: conn.execute(
            "UPDATE relay_container_reconciliation_observations "
            "SET updated_at = 23401 WHERE operation_id = '0043-dead-letter'"
        ),
        "0043 dead-letter observations must reject every update",
        "relay container reconciliation observation transition is invalid",
    )


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


def verify_relay_container_operation_rollout(schema_paths: list[Path]) -> None:
    operation_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0040_relay_container_operations.sql"
        ),
        None,
    )
    if operation_path is None:
        raise SystemExit("0040 relay Container operation migration not found")
    hardening_path = next(
        (
            path
            for path in schema_paths
            if path.name
            == "0041_relay_container_operation_lifecycle_hardening.sql"
        ),
        None,
    )
    if hardening_path is None:
        raise SystemExit("0041 relay Container lifecycle hardening migration not found")
    operation_index = schema_paths.index(operation_path)
    if operation_index == 0 or schema_paths[operation_index - 1].name != (
        "0039_task_submit_operation_enforce.sql"
    ):
        raise SystemExit("0040 must immediately follow the 0039 Task enforcement boundary")
    hardening_index = schema_paths.index(hardening_path)
    if hardening_index != operation_index + 1:
        raise SystemExit("0041 lifecycle hardening must immediately follow 0040")
    terminal_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0042_relay_container_financial_terminal_expand.sql"
        ),
        None,
    )
    if terminal_path is None:
        raise SystemExit("0042 relay Container financial terminal migration not found")
    if schema_paths.index(terminal_path) != hardening_index + 1:
        raise SystemExit("0042 financial terminal expand must immediately follow 0041")

    operation_sql = operation_path.read_text(encoding="utf-8")
    for fragment in (
        "CREATE TABLE IF NOT EXISTS relay_container_operations",
        "reservation_key TEXT PRIMARY KEY NOT NULL",
        "operation_id TEXT NOT NULL UNIQUE",
        "owner_lease_expires_at INTEGER NOT NULL",
        "provider_operation_id TEXT NOT NULL UNIQUE",
        "shard_contract_version INTEGER NOT NULL",
        "input_mode TEXT NOT NULL",
        "trace_id TEXT NOT NULL",
        "CHECK (operation_id = reservation_key)",
        "idx_relay_container_operations_recovery",
        "idx_relay_container_operations_shard",
        "idx_relay_container_operations_updated",
        "relay_container_operation_identity_immutable_guard",
        "relay_container_operation_lifecycle_guard",
    ):
        if fragment not in operation_sql:
            raise SystemExit(f"0040 operation authority contract missing: {fragment}")
    hardening_sql = hardening_path.read_text(encoding="utf-8")
    for fragment in (
        "DROP TRIGGER relay_container_operation_lifecycle_guard",
        "CREATE TRIGGER relay_container_operation_lifecycle_guard",
        "OLD.status IN ('completed', 'failed')",
        "NEW.status = OLD.status",
        "NEW.response_status IS NOT OLD.response_status",
        "NEW.result_object_key IS NOT OLD.result_object_key",
        "NEW.updated_at IS NOT OLD.updated_at",
        "OLD.status = 'prepared'",
        "OLD.status = 'dispatched'",
        "OLD.status = 'recovery_required'",
        "NEW.status IN ('completed', 'failed')",
    ):
        if fragment not in hardening_sql:
            raise SystemExit(f"0041 lifecycle hardening contract missing: {fragment}")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == operation_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))
    conn.execute(
        """
        INSERT INTO relay_billing_reservations (
          reservation_key, user_id, model_name, lease_expires_at, created_at, updated_at
        ) VALUES ('0040-existing-reservation', 1, 'guard-model', 5000, 4000, 4000)
        """
    )
    before = conn.execute(
        "SELECT reservation_key, status, lease_expires_at, owner_generation "
        "FROM relay_billing_reservations "
        "WHERE reservation_key = '0040-existing-reservation'"
    ).fetchone()
    conn.executescript(operation_sql)
    after = conn.execute(
        "SELECT reservation_key, status, lease_expires_at, owner_generation "
        "FROM relay_billing_reservations "
        "WHERE reservation_key = '0040-existing-reservation'"
    ).fetchone()
    if after != before:
        raise SystemExit(f"0040 expand migration changed billing authority data: {after}")
    if conn.execute("SELECT COUNT(*) FROM relay_container_operations").fetchone() != (
        0,
    ):
        raise SystemExit("0040 expand migration must not synthesize operation rows")

    conn.execute(
        """
        INSERT INTO relay_container_operations (
          reservation_key, operation_id,
          owner_generation, owner_lease_expires_at, channel_id, selected_group,
          operation_kind, provider_operation_id, admission_sha256,
          protocol_version, shard_contract_version,
          ring_generation, shard_count, shard_index, instance_name,
          execution_deadline_at, input_mode, input_object_key,
          input_object_version, input_sha256, input_size,
          input_content_type, trace_id, created_at, updated_at
        ) VALUES (
          '0041-existing-operation', '0041-existing-operation',
          1, 5100, 40, 'default',
          'relay_chat', 'provider:0041-existing-operation', lower(hex(zeroblob(32))),
          1, 1,
          7, 8, 2, 'cinatoken-relay-shard-v1-0002',
          5000, 'r2',
          'container-inputs/v1/0041-existing-operation/1/' || lower(hex(zeroblob(32))),
          'r2-version-1', lower(hex(zeroblob(32))), 128,
          'application/json', 'trace:0041-existing-operation', 4000, 4000
        )
        """
    )
    columns_before_hardening = conn.execute(
        "PRAGMA table_info(relay_container_operations)"
    ).fetchall()
    row_before_hardening = conn.execute(
        "SELECT * FROM relay_container_operations "
        "WHERE reservation_key = '0041-existing-operation'"
    ).fetchone()
    conn.executescript(hardening_sql)
    columns_after_hardening = conn.execute(
        "PRAGMA table_info(relay_container_operations)"
    ).fetchall()
    row_after_hardening = conn.execute(
        "SELECT * FROM relay_container_operations "
        "WHERE reservation_key = '0041-existing-operation'"
    ).fetchone()
    if columns_after_hardening != columns_before_hardening:
        raise SystemExit("0041 hardening must not change operation table columns")
    if row_after_hardening != row_before_hardening:
        raise SystemExit(
            f"0041 hardening changed an existing default-inert row: {row_after_hardening}"
        )
    if conn.execute("SELECT COUNT(*) FROM relay_container_operations").fetchone() != (
        1,
    ):
        raise SystemExit("0041 hardening must not synthesize operation rows")


def verify_relay_container_financial_terminal_rollout(
    schema_paths: list[Path],
) -> None:
    terminal_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0042_relay_container_financial_terminal_expand.sql"
        ),
        None,
    )
    if terminal_path is None:
        raise SystemExit("0042 relay Container financial terminal migration not found")
    terminal_index = schema_paths.index(terminal_path)
    if terminal_index == 0 or schema_paths[terminal_index - 1].name != (
        "0041_relay_container_operation_lifecycle_hardening.sql"
    ):
        raise SystemExit("0042 financial terminal expand must immediately follow 0041")
    if terminal_index + 1 >= len(schema_paths) or schema_paths[
        terminal_index + 1
    ].name != "0043_relay_container_reconciliation_observer.sql":
        raise SystemExit("0042 financial terminal expand must immediately precede 0043")

    terminal_sql = terminal_path.read_text(encoding="utf-8")
    for fragment in (
        "ADD COLUMN client_idempotency_hmac_sha256 TEXT NOT NULL DEFAULT ''",
        "ADD COLUMN client_request_sha256 TEXT NOT NULL DEFAULT ''",
        "ADD COLUMN reconciliation_id TEXT NOT NULL DEFAULT ''",
        "idx_relay_container_operations_client_idempotency_hmac",
        "idx_relay_container_operations_reconciliation_id",
        "DROP TRIGGER relay_container_operation_identity_immutable_guard",
        "NEW.client_idempotency_hmac_sha256 IS NOT OLD.client_idempotency_hmac_sha256",
        "NEW.client_request_sha256 IS NOT OLD.client_request_sha256",
        "NEW.reconciliation_id IS NOT OLD.reconciliation_id",
        "CREATE TABLE relay_container_terminal_events",
        "billing_from_status TEXT NOT NULL",
        "pre_consumed_quota INTEGER NOT NULL",
        "user_quota_delta INTEGER NOT NULL",
        "token_quota_delta INTEGER NOT NULL",
        "user_used_quota_delta INTEGER NOT NULL",
        "channel_used_quota_delta INTEGER NOT NULL",
        "request_count_delta INTEGER NOT NULL",
        "container-client-responses/v1/",
        "idx_relay_container_terminal_events_operation_identity",
        "idx_relay_container_terminal_events_reconciliation_identity",
        "relay_container_terminal_event_insert_guard",
        "relay_container_terminal_event_update_guard",
        "relay_container_terminal_event_delete_guard",
        "CREATE TABLE relay_container_terminal_outbox_state",
        "relay_container_terminal_outbox_identity_immutable_guard",
        "relay_container_terminal_outbox_lifecycle_guard",
    ):
        if fragment not in terminal_sql:
            raise SystemExit(f"0042 financial terminal contract missing: {fragment}")
    for forbidden in (
        "relay_container_operation_lifecycle_guard",
        "INSERT INTO relay_container_operations",
        "INSERT INTO relay_container_terminal_events",
        "INSERT INTO relay_container_terminal_outbox_state",
        "UPDATE relay_container_operations",
        "UPDATE relay_billing_reservations",
        "enforcement_enabled",
        "authority_enabled",
    ):
        if forbidden in terminal_sql:
            raise SystemExit(
                f"0042 expand migration must remain default-inert: {forbidden}"
            )

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == terminal_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))

    conn.execute(
        """
        INSERT INTO relay_billing_reservations (
          reservation_key, user_id, token_id, model_name,
          pre_consumed_quota, channel_id, selected_group, selected_at,
          lease_expires_at, owner_generation, owner_deadline_at,
          created_at, updated_at
        ) VALUES (
          '0042-existing-operation', 1, 0, 'guard-model',
          25, 40, 'default', 3900,
          5100, 1, 5000, 3800, 3900
        )
        """
    )
    conn.execute(
        """
        INSERT INTO relay_container_operations (
          reservation_key, operation_id,
          owner_generation, owner_lease_expires_at, channel_id, selected_group,
          operation_kind, provider_operation_id, admission_sha256,
          protocol_version, shard_contract_version,
          ring_generation, shard_count, shard_index, instance_name,
          execution_deadline_at, input_mode, input_object_key,
          input_object_version, input_sha256, input_size,
          input_content_type, trace_id, created_at, updated_at
        ) VALUES (
          '0042-existing-operation', '0042-existing-operation',
          1, 5100, 40, 'default',
          'relay_chat', 'provider:0042-existing-operation', lower(hex(zeroblob(32))),
          1, 1,
          7, 8, 2, 'cinatoken-relay-shard-v1-0002',
          5000, 'r2',
          'container-inputs/v1/0042-existing-operation/1/' || lower(hex(zeroblob(32))),
          'r2-version-1', lower(hex(zeroblob(32))), 128,
          'application/json', 'trace:0042-existing-operation', 4000, 4000
        )
        """
    )
    operation_columns_before = table_columns(conn, "relay_container_operations")
    operation_before = conn.execute(
        "SELECT * FROM relay_container_operations "
        "WHERE reservation_key = '0042-existing-operation'"
    ).fetchone()
    billing_before = conn.execute(
        "SELECT * FROM relay_billing_reservations "
        "WHERE reservation_key = '0042-existing-operation'"
    ).fetchone()
    lifecycle_before = sqlite_object_sql(
        conn, "trigger", "relay_container_operation_lifecycle_guard"
    )

    conn.executescript(terminal_sql)

    operation_columns_after = table_columns(conn, "relay_container_operations")
    if operation_columns_after - operation_columns_before != {
        "client_idempotency_hmac_sha256",
        "client_request_sha256",
        "reconciliation_id",
    }:
        raise SystemExit(
            "0042 expand migration added an unexpected operation column set: "
            f"{sorted(operation_columns_after - operation_columns_before)}"
        )
    if operation_columns_before - operation_columns_after:
        raise SystemExit("0042 expand migration removed operation columns")
    operation_after = conn.execute(
        "SELECT * FROM relay_container_operations "
        "WHERE reservation_key = '0042-existing-operation'"
    ).fetchone()
    if operation_after[:-3] != operation_before or operation_after[-3:] != ("", "", ""):
        raise SystemExit(
            f"0042 changed an existing legacy operation row: {operation_after}"
        )
    billing_after = conn.execute(
        "SELECT * FROM relay_billing_reservations "
        "WHERE reservation_key = '0042-existing-operation'"
    ).fetchone()
    if billing_after != billing_before:
        raise SystemExit("0042 expand migration changed existing billing authority data")
    lifecycle_after = sqlite_object_sql(
        conn, "trigger", "relay_container_operation_lifecycle_guard"
    )
    if lifecycle_after != lifecycle_before:
        raise SystemExit("0042 expand migration changed the 0041 lifecycle graph")
    for table in (
        "relay_container_terminal_events",
        "relay_container_terminal_outbox_state",
    ):
        if conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone() != (0,):
            raise SystemExit(f"0042 expand migration synthesized rows in {table}")

    conn.execute(
        """
        INSERT INTO relay_container_operations (
          reservation_key, operation_id,
          owner_generation, owner_lease_expires_at, channel_id, selected_group,
          operation_kind, provider_operation_id, admission_sha256,
          protocol_version, shard_contract_version,
          ring_generation, shard_count, shard_index, instance_name,
          execution_deadline_at, input_mode, input_object_key,
          input_object_version, input_sha256, input_size,
          input_content_type, trace_id, created_at, updated_at
        ) VALUES (
          '0042-post-expand-legacy', '0042-post-expand-legacy',
          1, 6100, 40, 'default',
          'relay_chat', 'provider:0042-post-expand-legacy', lower(hex(zeroblob(32))),
          1, 1,
          7, 8, 3, 'cinatoken-relay-shard-v1-0003',
          6000, 'r2',
          'container-inputs/v1/0042-post-expand-legacy/1/' || lower(hex(zeroblob(32))),
          'r2-version-2', lower(hex(zeroblob(32))), 64,
          'application/json', 'trace:0042-post-expand-legacy', 5200, 5200
        )
        """
    )
    legacy_defaults = conn.execute(
        "SELECT client_idempotency_hmac_sha256, client_request_sha256, "
        "reconciliation_id FROM relay_container_operations "
        "WHERE reservation_key = '0042-post-expand-legacy'"
    ).fetchone()
    if legacy_defaults != ("", "", ""):
        raise SystemExit(f"0042 broke a legacy operation writer: {legacy_defaults}")

    partial_indexes = {
        "idx_relay_container_operations_client_idempotency_hmac": (
            "WHERE client_idempotency_hmac_sha256 <> ''"
        ),
        "idx_relay_container_operations_reconciliation_id": (
            "WHERE reconciliation_id <> ''"
        ),
        "idx_relay_container_terminal_outbox_pending": "WHERE status = 'pending'",
        "idx_relay_container_terminal_outbox_leased": "WHERE status = 'leased'",
    }
    for index_name, predicate in partial_indexes.items():
        index_sql = sqlite_object_sql(conn, "index", index_name)
        if index_sql is None or predicate not in index_sql:
            raise SystemExit(
                f"0042 partial index manifest is incomplete: {index_name}"
            )


def verify_relay_container_reconciliation_observer_rollout(
    schema_paths: list[Path],
) -> None:
    observer_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0043_relay_container_reconciliation_observer.sql"
        ),
        None,
    )
    terminal_path = next(
        (
            path
            for path in schema_paths
            if path.name == "0042_relay_container_financial_terminal_expand.sql"
        ),
        None,
    )
    if observer_path is None or terminal_path is None:
        raise SystemExit("0042/0043 relay Container observer rollout migrations not found")
    observer_index = schema_paths.index(observer_path)
    if observer_index == 0 or schema_paths[observer_index - 1] != terminal_path:
        raise SystemExit("0043 reconciliation observer must immediately follow 0042")
    if observer_index != len(schema_paths) - 1:
        raise SystemExit("0043 reconciliation observer must be the current D1 migration head")

    observer_sql = observer_path.read_text(encoding="utf-8")
    if "if not exists" in observer_sql.lower():
        raise SystemExit("0043 critical observer objects must fail on duplicate DDL")
    for fragment in (
        "CREATE TABLE relay_container_reconciliation_observations",
        "operation_id TEXT PRIMARY KEY NOT NULL",
        "reservation_key TEXT NOT NULL UNIQUE",
        "operation_created_at INTEGER NOT NULL",
        "owner_generation INTEGER NOT NULL",
        "reconciliation_id TEXT NOT NULL",
        "status IN ('pending', 'leased', 'retry', 'converged', 'dead_letter')",
        "idx_relay_container_reconciliation_observations_due",
        "idx_relay_container_reconciliation_observations_lease",
        "idx_relay_container_reconciliation_observations_class",
        "relay_container_reconciliation_observation_insert_guard",
        "relay_container_reconciliation_observation_identity_immutable_guard",
        "relay_container_reconciliation_observation_lifecycle_guard",
        "relay_container_reconciliation_observation_delete_guard",
        "CREATE TABLE relay_container_reconciliation_cursor",
        "cursor_name = 'operation_observer_v1'",
        "run_generation INTEGER NOT NULL",
        "run_owner TEXT NOT NULL",
        "run_lease_expires_at INTEGER NOT NULL",
        "last_started_at INTEGER NOT NULL",
        "last_completed_at INTEGER NOT NULL",
        "last_success_at INTEGER NOT NULL",
        "last_error_code TEXT NOT NULL",
        "NEW.run_generation = OLD.run_generation + 1",
        "OLD.run_lease_expires_at > NEW.updated_at",
        "relay_container_reconciliation_cursor_identity_immutable_guard",
        "relay_container_reconciliation_cursor_lifecycle_guard",
        "relay_container_reconciliation_cursor_delete_guard",
    ):
        if fragment not in observer_sql:
            raise SystemExit(f"0043 reconciliation observer contract missing: {fragment}")
    if observer_sql.count("INSERT INTO ") != 1 or (
        "INSERT INTO relay_container_reconciliation_cursor" not in observer_sql
    ):
        raise SystemExit("0043 must seed only the singleton observer cursor")
    for forbidden in (
        "INSERT INTO relay_container_reconciliation_observations",
        "UPDATE relay_container_operations",
        "UPDATE relay_container_terminal_events",
        "UPDATE relay_container_terminal_outbox_state",
        "DELETE FROM relay_container_operations",
        "DELETE FROM relay_container_terminal_events",
        "DELETE FROM relay_container_terminal_outbox_state",
    ):
        if forbidden in observer_sql:
            raise SystemExit(f"0043 observer expand must remain default-lazy: {forbidden}")

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        if schema_path == observer_path:
            break
        conn.executescript(schema_path.read_text(encoding="utf-8"))

    def insert_0042_operation(key: str, created_at: int, owner_generation: int) -> None:
        input_sha256 = hashlib.sha256(f"input:{key}".encode("utf-8")).hexdigest()
        values: dict[str, object] = {
            "reservation_key": key,
            "operation_id": key,
            "owner_generation": owner_generation,
            "owner_lease_expires_at": created_at + 3000,
            "channel_id": 43,
            "selected_group": "default",
            "operation_kind": "relay_chat",
            "provider_operation_id": f"provider:{key}",
            "admission_sha256": hashlib.sha256(
                f"admission:{key}".encode("utf-8")
            ).hexdigest(),
            "protocol_version": 1,
            "shard_contract_version": 1,
            "ring_generation": 8,
            "shard_count": 8,
            "shard_index": 4,
            "instance_name": "cinatoken-relay-shard-v1-0004",
            "execution_deadline_at": created_at + 2000,
            "input_mode": "r2",
            "input_object_key": (
                f"container-inputs/v1/{key}/{owner_generation}/{input_sha256}"
            ),
            "input_object_version": "r2-version-0042-compatible",
            "input_sha256": input_sha256,
            "input_size": 128,
            "input_content_type": "application/json",
            "trace_id": f"trace:{key}",
            "client_idempotency_hmac_sha256": hashlib.sha256(
                f"client:{key}".encode("utf-8")
            ).hexdigest(),
            "client_request_sha256": hashlib.sha256(
                f"request:{key}".encode("utf-8")
            ).hexdigest(),
            "reconciliation_id": hashlib.sha256(
                f"reconciliation:{key}".encode("utf-8")
            ).hexdigest(),
            "created_at": created_at,
            "updated_at": created_at,
        }
        conn.execute(
            """
            INSERT INTO relay_container_operations (
              reservation_key, operation_id,
              owner_generation, owner_lease_expires_at, channel_id, selected_group,
              operation_kind, provider_operation_id, admission_sha256,
              protocol_version, shard_contract_version,
              ring_generation, shard_count, shard_index, instance_name,
              execution_deadline_at, input_mode, input_object_key,
              input_object_version, input_sha256, input_size,
              input_content_type, trace_id,
              client_idempotency_hmac_sha256, client_request_sha256,
              reconciliation_id, created_at, updated_at
            ) VALUES (
              :reservation_key, :operation_id,
              :owner_generation, :owner_lease_expires_at, :channel_id, :selected_group,
              :operation_kind, :provider_operation_id, :admission_sha256,
              :protocol_version, :shard_contract_version,
              :ring_generation, :shard_count, :shard_index, :instance_name,
              :execution_deadline_at, :input_mode, :input_object_key,
              :input_object_version, :input_sha256, :input_size,
              :input_content_type, :trace_id,
              :client_idempotency_hmac_sha256, :client_request_sha256,
              :reconciliation_id, :created_at, :updated_at
            )
            """,
            values,
        )

    insert_0042_operation("0043-existing-operation", 4000, 2)
    operation_columns_before = table_columns(conn, "relay_container_operations")
    operation_before = conn.execute(
        "SELECT * FROM relay_container_operations "
        "WHERE operation_id = '0043-existing-operation'"
    ).fetchone()
    protected_0042_objects = (
        "relay_container_operation_lifecycle_guard",
        "relay_container_terminal_event_insert_guard",
        "relay_container_terminal_outbox_lifecycle_guard",
    )
    object_sql_before = {
        name: sqlite_object_sql(conn, "trigger", name)
        for name in protected_0042_objects
    }

    conn.executescript(observer_sql)

    if table_columns(conn, "relay_container_operations") != operation_columns_before:
        raise SystemExit("0043 observer expand changed the 0042 operation columns")
    operation_after = conn.execute(
        "SELECT * FROM relay_container_operations "
        "WHERE operation_id = '0043-existing-operation'"
    ).fetchone()
    if operation_after != operation_before:
        raise SystemExit("0043 observer expand changed an existing 0042 operation")
    object_sql_after = {
        name: sqlite_object_sql(conn, "trigger", name)
        for name in protected_0042_objects
    }
    if object_sql_after != object_sql_before:
        raise SystemExit("0043 observer expand changed an existing 0042 trigger")
    if conn.execute(
        "SELECT COUNT(*) FROM relay_container_reconciliation_observations"
    ).fetchone() != (0,):
        raise SystemExit("0043 observer expand backfilled existing 0042 operations")
    seeded_cursor = conn.execute(
        "SELECT cursor_name, last_created_at, last_reservation_key, "
        "round_high_created_at, round_high_reservation_key, scan_generation, "
        "run_generation, run_owner, run_lease_expires_at, last_started_at, "
        "last_completed_at, last_success_at, last_error_code, updated_at "
        "FROM relay_container_reconciliation_cursor"
    ).fetchall()
    if seeded_cursor != [
        ("operation_observer_v1", 0, "", 0, "", 0, 0, "", 0, 0, 0, 0, "", 0)
    ]:
        raise SystemExit(f"0043 observer expand seeded unexpected control data: {seeded_cursor}")

    insert_0042_operation("0043-post-expand-operation", 8000, 3)
    conn.execute(
        "UPDATE relay_container_operations SET status = 'dispatched', "
        "updated_at = 8100 WHERE operation_id = '0043-post-expand-operation'"
    )
    post_expand = conn.execute(
        "SELECT status, reconciliation_id FROM relay_container_operations "
        "WHERE operation_id = '0043-post-expand-operation'"
    ).fetchone()
    if post_expand is None or post_expand[0] != "dispatched" or len(post_expand[1]) != 64:
        raise SystemExit(f"0043 broke an unaware 0042 operation writer: {post_expand}")
    if conn.execute(
        "SELECT COUNT(*) FROM relay_container_reconciliation_observations"
    ).fetchone() != (0,):
        raise SystemExit("0043 must remain lazy after 0042-compatible operation writes")
    for table in (
        "relay_container_terminal_events",
        "relay_container_terminal_outbox_state",
    ):
        if conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone() != (0,):
            raise SystemExit(f"0043 observer expand synthesized rows in {table}")


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
