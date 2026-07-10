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
]

REQUIRED_COLUMNS = {
    "abilities": {"tag"},
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
    },
}

REQUIRED_INDEXES = {
    "abilities": {"uq_abilities_group_model_channel": True},
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
