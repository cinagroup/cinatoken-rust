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
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify D1 SQL with Python sqlite3.")
    parser.add_argument(
        "--schema",
        default="migrations/d1/0001_core.sql",
        help="D1 schema SQL file",
    )
    parser.add_argument("--seed", help="Optional seed SQL file to execute after schema")
    args = parser.parse_args()

    schema_path = Path(args.schema)
    if not schema_path.exists():
        raise SystemExit(f"schema file not found: {schema_path}")

    conn = sqlite3.connect(":memory:")
    conn.executescript(schema_path.read_text(encoding="utf-8"))

    missing = [
        table
        for table in REQUIRED_TABLES
        if not table_exists(conn, table)
    ]
    if missing:
        raise SystemExit(f"missing tables: {', '.join(missing)}")

    message = f"sqlite schema ok: {len(REQUIRED_TABLES)} tables"

    if args.seed:
        seed_path = Path(args.seed)
        if not seed_path.exists():
            raise SystemExit(f"seed file not found: {seed_path}")
        conn.executescript(seed_path.read_text(encoding="utf-8"))
        counts = {
            table: conn.execute(f"select count(*) from {table}").fetchone()[0]
            for table in ("users", "tokens", "channels", "abilities")
        }
        if counts != {"users": 1, "tokens": 1, "channels": 1, "abilities": 1}:
            raise SystemExit(f"unexpected dev seed counts: {counts}")
        message += " + seed ok: users=1 tokens=1 channels=1 abilities=1"

    print(message)
    return 0


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "select 1 from sqlite_master where type = 'table' and name = ?",
        (table,),
    ).fetchone()
    return row is not None


if __name__ == "__main__":
    raise SystemExit(main())
