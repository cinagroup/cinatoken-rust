#!/usr/bin/env python3
import argparse
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
]

REQUIRED_COLUMNS = {
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
    },
    "realtime_billing_recovery_state": {
        "id",
        "last_started_at",
        "last_completed_at",
        "last_success_at",
        "last_candidates",
        "last_refunded",
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
}

REQUIRED_INDEXES = {
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
    if not args.schema:
        verify_realtime_lease_migration_guard(schema_paths)
        lease_guard_verified = True
        verify_realtime_segment_migration_guard(schema_paths)
        segment_guard_verified = True

    conn = sqlite3.connect(":memory:")
    for schema_path in schema_paths:
        try:
            conn.executescript(schema_path.read_text(encoding="utf-8"))
        except sqlite3.Error as error:
            raise SystemExit(f"migration failed: {schema_path}: {error}") from error

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


if __name__ == "__main__":
    raise SystemExit(main())
