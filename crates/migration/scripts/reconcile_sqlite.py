import base64
import hashlib
import heapq
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone


MANIFEST_FORMAT = "cinatoken-source-to-d1-reconciliation-v1"
RESULT_FORMAT = "cinatoken-source-to-d1-reconciliation-result-v1"
SERIALIZATION = "cinatoken-sqlite-canonical-row-v1"
SAMPLE_ALGORITHM = "sha256-smallest-logical-pk-v1"

TABLE_SPECS = (
    {
        "name": "users",
        "logical_pk": ("id",),
        "json_columns": ("setting",),
        "columns": (
            "id",
            "username",
            "password",
            "display_name",
            "role",
            "status",
            "email",
            "github_id",
            "discord_id",
            "oidc_id",
            "wechat_id",
            "telegram_id",
            "linux_do_id",
            "access_token",
            "quota",
            "used_quota",
            "request_count",
            "group",
            "aff_code",
            "aff_count",
            "aff_quota",
            "aff_history",
            "inviter_id",
            "setting",
            "remark",
            "stripe_customer",
            "created_at",
            "last_login_at",
            "deleted_at",
        ),
    },
    {
        "name": "tokens",
        "logical_pk": ("id",),
        "json_columns": (),
        "columns": (
            "id",
            "user_id",
            "key",
            "status",
            "name",
            "created_time",
            "accessed_time",
            "expired_time",
            "remain_quota",
            "unlimited_quota",
            "model_limits_enabled",
            "model_limits",
            "allow_ips",
            "used_quota",
            "group",
            "cross_group_retry",
            "deleted_at",
        ),
    },
    {
        "name": "channels",
        "logical_pk": ("id",),
        "json_columns": (
            "model_mapping",
            "status_code_mapping",
            "other_info",
            "setting",
            "param_override",
            "header_override",
            "channel_info",
            "settings",
        ),
        "columns": (
            "id",
            "type",
            "key",
            "openai_organization",
            "test_model",
            "status",
            "name",
            "weight",
            "created_time",
            "test_time",
            "response_time",
            "base_url",
            "other",
            "balance",
            "balance_updated_time",
            "models",
            "group",
            "used_quota",
            "model_mapping",
            "status_code_mapping",
            "priority",
            "auto_ban",
            "other_info",
            "tag",
            "setting",
            "param_override",
            "header_override",
            "remark",
            "channel_info",
            "settings",
        ),
    },
    {
        "name": "abilities",
        "logical_pk": ("group_name", "model", "channel_id"),
        "json_columns": (),
        "columns": (
            "group_name",
            "model",
            "channel_id",
            "enabled",
            "priority",
            "weight",
            "tag",
        ),
        "source_columns": {"group_name": "group"},
    },
    {
        "name": "options",
        "logical_pk": ("key",),
        "json_columns": ("value",),
        "columns": ("key", "value"),
    },
    {
        "name": "topups",
        "source_name": "top_ups",
        "logical_pk": ("trade_no",),
        "json_columns": (),
        "columns": (
            "id",
            "user_id",
            "amount",
            "money",
            "trade_no",
            "payment_method",
            "payment_provider",
            "status",
            "create_time",
            "complete_time",
            "credited",
        ),
        "computed_source_columns": ("payment_provider", "status", "credited"),
    },
    {
        "name": "passkey_credentials",
        "logical_pk": ("id",),
        "json_columns": (),
        "boolean_columns": (
            "clone_warning",
            "user_present",
            "user_verified",
            "backup_eligible",
            "backup_state",
        ),
        "timestamp_columns": (
            "last_used_at",
            "created_at",
            "updated_at",
            "deleted_at",
        ),
        "columns": (
            "id",
            "user_id",
            "credential_id",
            "public_key",
            "attestation_type",
            "aaguid",
            "sign_count",
            "clone_warning",
            "user_present",
            "user_verified",
            "backup_eligible",
            "backup_state",
            "transports",
            "attachment",
            "last_used_at",
            "created_at",
            "updated_at",
            "deleted_at",
        ),
    },
    {
        "name": "two_fa",
        "source_name": "two_fas",
        "source_where": "deleted_at IS NULL",
        "logical_pk": ("id",),
        "json_columns": (),
        "boolean_columns": ("is_enabled",),
        "timestamp_columns": (
            "locked_until",
            "last_used_at",
            "created_at",
            "updated_at",
        ),
        "columns": (
            "id",
            "user_id",
            "secret",
            "is_enabled",
            "failed_attempts",
            "locked_until",
            "last_used_at",
            "created_at",
            "updated_at",
        ),
    },
    {
        "name": "two_fa_backup_codes",
        "source_where": "deleted_at IS NULL",
        "logical_pk": ("id",),
        "json_columns": (),
        "boolean_columns": ("is_used",),
        "timestamp_columns": ("used_at", "created_at"),
        "columns": (
            "id",
            "user_id",
            "code_hash",
            "is_used",
            "used_at",
            "created_at",
        ),
    },
    {
        "name": "midjourneys",
        "logical_pk": ("id",),
        "json_columns": (),
        "integer_columns": (
            "id",
            "code",
            "user_id",
            "submit_time",
            "start_time",
            "finish_time",
            "channel_id",
            "quota",
        ),
        "columns": (
            "id",
            "code",
            "user_id",
            "action",
            "mj_id",
            "prompt",
            "prompt_en",
            "description",
            "state",
            "submit_time",
            "start_time",
            "finish_time",
            "image_url",
            "video_url",
            "video_urls",
            "status",
            "progress",
            "fail_reason",
            "channel_id",
            "quota",
            "buttons",
            "properties",
        ),
    },
    {
        "name": "prefill_groups",
        "logical_pk": ("id",),
        "json_columns": (),
        "integer_columns": ("id", "created_time", "updated_time"),
        "timestamp_columns": ("deleted_at",),
        "json_text_columns": ("items",),
        "columns": (
            "id",
            "name",
            "type",
            "items",
            "description",
            "created_time",
            "updated_time",
            "deleted_at",
        ),
    },
)

EXCLUDED_SOURCE_FAMILIES = (
    {
        "source": "quota_data",
        "decision": "exclude",
        "reason": "derived hourly usage aggregates have no lossless D1 target and importing them would double count migrated logs",
        "replacement": "rebuild usage and ranking views from the migrated D1 logs table",
        "columns": (
            "id",
            "user_id",
            "username",
            "model_name",
            "created_at",
            "token_used",
            "count",
            "quota",
        ),
    },
    {
        "source": "setups",
        "decision": "exclude",
        "reason": "the Go installation marker describes the retired VPS deployment rather than tenant business state",
        "replacement": "derive Worker readiness from applied D1 migrations and Cloudflare bindings",
        "columns": ("id", "version", "initialized_at"),
    },
    {
        "source": "perf_metrics",
        "decision": "exclude",
        "reason": "rolling observability aggregates have no parity D1 table and are safe to rewarm after cutover",
        "replacement": "rebuild operational metrics from new relay traffic and retained D1 logs",
        "columns": (
            "id",
            "model_name",
            "group",
            "bucket_ts",
            "request_count",
            "success_count",
            "total_latency_ms",
            "ttft_sum_ms",
            "ttft_count",
            "output_tokens",
            "generation_ms",
        ),
    },
)

TOPUP_PAYMENT_PROVIDERS = (
    "epay",
    "stripe",
    "creem",
    "waffo",
    "waffo_pancake",
    "balance",
)


def quote_ident(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def open_read_only(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def table_schema(conn, table):
    exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    if exists is None:
        raise ValueError(f"required table is missing: {table}")

    columns = {}
    for _, name, data_type, not_null, default_sql, primary_key in conn.execute(
        f"PRAGMA table_info({quote_ident(table)})"
    ):
        default_value = None
        has_default = default_sql is not None
        if has_default:
            try:
                default_value = conn.execute(f"SELECT {default_sql}").fetchone()[0]
            except sqlite3.Error as error:
                raise ValueError(
                    f"cannot evaluate default for {table}.{name}: {error}"
                ) from error
        columns[name] = {
            "type": data_type,
            "not_null": bool(not_null),
            "has_default": has_default,
            "default": default_value,
            "primary_key": int(primary_key),
        }
    return columns


def canonical_number(value):
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite SQLite numeric value cannot be reconciled")
    if value == 0:
        return "0"
    if value.is_integer():
        return str(int(value))
    return repr(value)


def canonical_value(value, normalize_json=False):
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["number", "1" if value else "0"]
    if isinstance(value, (int, float)):
        return ["number", canonical_number(value)]
    if isinstance(value, bytes):
        return ["blob", base64.b64encode(value).decode("ascii")]
    if isinstance(value, str) and normalize_json:
        try:
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list)):
                normalized = json.dumps(
                    parsed,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                return ["json", normalized]
        except (TypeError, ValueError):
            pass
    if isinstance(value, str):
        return ["text", value]
    raise ValueError(f"unsupported SQLite value type: {type(value).__name__}")


def canonical_bytes(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def source_column(spec, target_column):
    return spec.get("source_columns", {}).get(target_column, target_column)


def table_name(spec, role):
    if role == "source":
        return spec.get("source_name", spec["name"])
    return spec["name"]


def map_topup_status(value):
    statuses = {"pending": 0, "success": 1, "failed": 2, "expired": 3}
    if value not in statuses:
        raise ValueError(f"unsupported source top_ups status: {value!r}")
    return statuses[value]


def map_topup_provider(row):
    payment_method = row.get("payment_method")
    if not isinstance(payment_method, str) or not payment_method:
        raise ValueError("source top_ups payment_method must be a non-empty string")

    provider = row.get("payment_provider")
    if provider is None or provider == "":
        return payment_method if payment_method in TOPUP_PAYMENT_PROVIDERS else "epay"
    if not isinstance(provider, str):
        raise ValueError("source top_ups payment_provider must be a string")
    if provider not in TOPUP_PAYMENT_PROVIDERS:
        raise ValueError(f"unsupported source top_ups payment_provider: {provider!r}")
    return provider


def normalize_boolean(value, table, column):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int) and value in (0, 1):
        return value
    raise ValueError(f"{table}.{column} must be boolean or 0/1")


def normalize_timestamp(value, table, column):
    if isinstance(value, bool):
        raise ValueError(f"{table}.{column} must not be boolean")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"{table}.{column} must be an integer Unix timestamp or supported Go SQLite datetime"
        )

    raw = value.strip()
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError as error:
        raise ValueError(
            f"{table}.{column} has unsupported Go SQLite datetime {value!r}"
        ) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    utc = parsed.astimezone(timezone.utc)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = utc - epoch
    return delta.days * 86400 + delta.seconds


def normalize_integer(value, table, column):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{table}.{column} must be an integer")
    return value


def normalize_json_text(value, table, column):
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"{table}.{column} must contain UTF-8 JSON") from error
    if not isinstance(value, str):
        raise ValueError(f"{table}.{column} must be JSON text")
    try:
        json.loads(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{table}.{column} must contain valid JSON") from error
    return value


def role_where(spec, role):
    if role == "source":
        return spec.get("source_where")
    return spec.get("target_where")


def row_query(conn, spec, role, schema):
    if role == "source":
        selected = []
        for target_column in spec["columns"]:
            name = source_column(spec, target_column)
            if name in schema and name not in selected:
                selected.append(name)
        order_columns = [source_column(spec, name) for name in spec["logical_pk"]]
    else:
        selected = list(spec["columns"])
        order_columns = list(spec["logical_pk"])

    missing_keys = [name for name in order_columns if name not in schema]
    if missing_keys:
        raise ValueError(
            f"{role} table {spec['name']} is missing logical key columns: "
            + ", ".join(missing_keys)
        )

    select_sql = ", ".join(quote_ident(name) for name in selected)
    order_sql = ", ".join(quote_ident(name) for name in order_columns)
    where = role_where(spec, role)
    where_sql = f" WHERE {where}" if where else ""
    cursor = conn.execute(
        f"SELECT {select_sql} FROM {quote_ident(table_name(spec, role))}"
        f"{where_sql} ORDER BY {order_sql}"
    )
    names = [description[0] for description in cursor.description]
    return cursor, names


def project_row(spec, role, names, raw_row, target_schema):
    row = dict(zip(names, raw_row))
    projected = {}
    for target_column in spec["columns"]:
        if role == "source" and spec["name"] == "topups":
            if target_column == "status":
                projected[target_column] = map_topup_status(row.get("status"))
                continue
            if target_column == "payment_provider":
                projected[target_column] = map_topup_provider(row)
                continue
            if target_column == "credited":
                projected[target_column] = int(
                    map_topup_status(row.get("status")) == 1
                )
                continue

        name = source_column(spec, target_column) if role == "source" else target_column
        value = row.get(name)
        if name in row and value is not None:
            if target_column in spec.get("boolean_columns", ()):
                value = normalize_boolean(value, spec["name"], target_column)
            elif target_column in spec.get("timestamp_columns", ()):
                value = normalize_timestamp(value, spec["name"], target_column)
            elif target_column in spec.get("integer_columns", ()):
                value = normalize_integer(value, spec["name"], target_column)
            elif target_column in spec.get("json_text_columns", ()):
                value = normalize_json_text(value, spec["name"], target_column)
            projected[target_column] = value
            continue

        column = target_schema[target_column]
        if column["has_default"]:
            projected[target_column] = column["default"]
        elif column["not_null"]:
            raise ValueError(
                f"source {spec['name']}.{name} is null or missing, but target "
                f"{spec['name']}.{target_column} is NOT NULL without a default"
            )
        else:
            projected[target_column] = None
    return projected


def table_manifest(conn, spec, role, schema, target_schema, sample_size):
    cursor, names = row_query(conn, spec, role, schema)
    table_hash = hashlib.sha256()
    table_hash.update(
        canonical_bytes(
            {
                "serialization": SERIALIZATION,
                "table": spec["name"],
                "columns": spec["columns"],
            }
        )
    )
    table_hash.update(b"\n")

    samples = []
    count = 0
    pk_min = None
    pk_max = None
    defaulted_columns = []
    if role == "source":
        defaulted_columns = sorted(
            target_column
            for target_column in spec["columns"]
            if source_column(spec, target_column) not in schema
            and target_column not in spec.get("computed_source_columns", ())
        )

    for raw_row in cursor:
        projected = project_row(spec, role, names, raw_row, target_schema)
        pk = [canonical_value(projected[name]) for name in spec["logical_pk"]]
        json_columns = spec.get("json_columns", ())
        values = [
            canonical_value(projected[name], name in json_columns)
            for name in spec["columns"]
        ]
        record = [pk, values]
        record_bytes = canonical_bytes(record)

        table_hash.update(record_bytes)
        table_hash.update(b"\n")
        row_hash = hashlib.sha256(record_bytes).hexdigest()
        pk_bytes = canonical_bytes(pk)
        sample_score = int.from_bytes(
            hashlib.sha256(
                b"cinatoken-reconciliation-sample-v1\0"
                + spec["name"].encode("utf-8")
                + b"\0"
                + pk_bytes
            ).digest(),
            "big",
        )
        sample = (
            -sample_score,
            pk_bytes,
            count,
            {"pk": pk, "row_sha256": row_hash},
        )
        if len(samples) < sample_size:
            heapq.heappush(samples, sample)
        elif sample_score < -samples[0][0]:
            heapq.heapreplace(samples, sample)

        if count == 0:
            pk_min = pk
        pk_max = pk
        count += 1

    selected_samples = [entry[3] for entry in sorted(samples, key=lambda item: item[1:3])]
    manifest = {
        "logical_primary_key": list(spec["logical_pk"]),
        "columns": list(spec["columns"]),
        "count": count,
        "pk_min": pk_min,
        "pk_max": pk_max,
        "sha256": table_hash.hexdigest(),
        "samples": selected_samples,
    }
    if role == "source":
        manifest["source_defaulted_columns"] = defaulted_columns
    return manifest


def count_query(conn, sql):
    return int(conn.execute(sql).fetchone()[0])


def condition_count(conn, table, role_filter, condition):
    where = f"({role_filter}) AND ({condition})" if role_filter else condition
    return count_query(
        conn,
        f"SELECT COUNT(*) FROM {quote_ident(table)} WHERE {where}",
    )


def logical_key_checks(conn, role):
    checks = {}
    for spec in TABLE_SPECS:
        table = table_name(spec, role)
        role_filter = role_where(spec, role)
        where_sql = f" WHERE {role_filter}" if role_filter else ""
        conjunction = " AND " if role_filter else " WHERE "
        keys = [
            source_column(spec, name) if role == "source" else name
            for name in spec["logical_pk"]
        ]
        key_sql = ", ".join(quote_ident(name) for name in keys)
        null_sql = " OR ".join(f"{quote_ident(name)} IS NULL" for name in keys)
        duplicate_groups = count_query(
            conn,
            f"SELECT COUNT(*) FROM ("
            f"SELECT 1 FROM {quote_ident(table)}{where_sql} "
            f"GROUP BY {key_sql} HAVING COUNT(*) > 1"
            f")",
        )
        null_keys = count_query(
            conn,
            f"SELECT COUNT(*) FROM {quote_ident(table)}{where_sql}"
            f"{conjunction}({null_sql})",
        )
        checks[f"{spec['name']}.logical_primary_key"] = {
            "kind": "logical_primary_key",
            "duplicate_key_groups": duplicate_groups,
            "null_key_rows": null_keys,
            "violations": duplicate_groups + null_keys,
        }

    option_key = quote_ident("key")
    checks["options.key_non_empty"] = {
        "kind": "domain_integrity",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM {quote_ident('options')} "
            f"WHERE TRIM({option_key}) = ''",
        ),
    }


    topups_table = "top_ups" if role == "source" else "topups"
    if role == "source":
        status_condition = (
            '"status" IS NULL OR "status" NOT IN '
            "('pending', 'success', 'failed', 'expired')"
        )
        topups_schema = table_schema(conn, topups_table)
        if "payment_provider" in topups_schema:
            provider_condition = (
                '("payment_provider" IS NOT NULL AND "payment_provider" <> \'\' '
                "AND \"payment_provider\" NOT IN ('epay', 'stripe', 'creem', "
                "'waffo', 'waffo_pancake', 'balance')) OR "
                "((\"payment_provider\" IS NULL OR \"payment_provider\" = '') "
                "AND (\"payment_method\" IS NULL OR \"payment_method\" = ''))"
            )
        else:
            provider_condition = '"payment_method" IS NULL OR "payment_method" = \'\''
        credited_violations = 0
    else:
        status_condition = '"status" IS NULL OR "status" NOT IN (0, 1, 2, 3)'
        provider_condition = (
            '"payment_provider" IS NULL OR "payment_provider" NOT IN '
            "('epay', 'stripe', 'creem', 'waffo', 'waffo_pancake', 'balance')"
        )
        credited_violations = count_query(
            conn,
            f"SELECT COUNT(*) FROM {quote_ident(topups_table)} "
            "WHERE credited IS NULL OR credited NOT IN (0, 1) "
            "OR credited <> CASE WHEN status = 1 THEN 1 ELSE 0 END",
        )
    checks["topups.status_domain"] = {
        "kind": "domain_integrity",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM {quote_ident(topups_table)} WHERE {status_condition}",
        ),
    }
    checks["topups.payment_provider_domain"] = {
        "kind": "domain_integrity",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM {quote_ident(topups_table)} WHERE {provider_condition}",
        ),
    }
    checks["topups.credited_matches_status"] = {
        "kind": "domain_integrity",
        "violations": credited_violations,
    }

    passkey_table = "passkey_credentials"
    checks["passkey_credentials.user_id_unique"] = {
        "kind": "unique_key",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM (SELECT 1 FROM {quote_ident(passkey_table)} "
            "GROUP BY user_id HAVING COUNT(*) > 1)",
        ),
    }
    checks["passkey_credentials.credential_id_unique"] = {
        "kind": "unique_key",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM (SELECT 1 FROM {quote_ident(passkey_table)} "
            "GROUP BY credential_id HAVING COUNT(*) > 1)",
        ),
    }
    checks["passkey_credentials.security_domain"] = {
        "kind": "domain_integrity",
        "violations": condition_count(
            conn,
            passkey_table,
            None,
            "credential_id IS NULL OR credential_id = '' "
            "OR public_key IS NULL OR public_key = '' "
            "OR sign_count IS NULL OR sign_count < 0 OR sign_count > 4294967295 "
            "OR clone_warning IS NULL OR clone_warning NOT IN (0, 1) "
            "OR user_present IS NULL OR user_present NOT IN (0, 1) "
            "OR user_verified IS NULL OR user_verified NOT IN (0, 1) "
            "OR backup_eligible IS NULL OR backup_eligible NOT IN (0, 1) "
            "OR backup_state IS NULL OR backup_state NOT IN (0, 1)",
        ),
    }

    two_fa_spec = next(spec for spec in TABLE_SPECS if spec["name"] == "two_fa")
    two_fa_table = table_name(two_fa_spec, role)
    two_fa_filter = role_where(two_fa_spec, role)
    checks["two_fa.user_id_unique"] = {
        "kind": "unique_key",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM (SELECT 1 FROM {quote_ident(two_fa_table)}"
            + (f" WHERE {two_fa_filter}" if two_fa_filter else "")
            + " GROUP BY user_id HAVING COUNT(*) > 1)",
        ),
    }
    checks["two_fa.security_domain"] = {
        "kind": "domain_integrity",
        "violations": condition_count(
            conn,
            two_fa_table,
            two_fa_filter,
            "secret IS NULL OR secret = '' OR is_enabled IS NULL OR is_enabled NOT IN (0, 1) "
            "OR failed_attempts IS NULL OR failed_attempts < 0",
        ),
    }

    backup_spec = next(
        spec for spec in TABLE_SPECS if spec["name"] == "two_fa_backup_codes"
    )
    backup_table = table_name(backup_spec, role)
    backup_filter = role_where(backup_spec, role)
    checks["two_fa_backup_codes.security_domain"] = {
        "kind": "domain_integrity",
        "violations": condition_count(
            conn,
            backup_table,
            backup_filter,
            "code_hash IS NULL OR code_hash = '' OR is_used IS NULL OR is_used NOT IN (0, 1) "
            "OR (is_used = 1 AND used_at IS NULL)",
        ),
    }

    midjourneys = "midjourneys"
    checks["midjourneys.value_domain"] = {
        "kind": "domain_integrity",
        "violations": condition_count(
            conn,
            midjourneys,
            None,
            "id <= 0 OR code < 0 OR user_id < 0 OR submit_time < 0 "
            "OR start_time < 0 OR finish_time < 0 OR channel_id < 0 OR quota < 0 "
            "OR action IS NULL OR mj_id IS NULL OR prompt IS NULL OR prompt_en IS NULL "
            "OR description IS NULL OR state IS NULL OR image_url IS NULL "
            "OR video_url IS NULL OR video_urls IS NULL OR status IS NULL "
            "OR progress IS NULL OR fail_reason IS NULL OR buttons IS NULL "
            "OR properties IS NULL",
        ),
    }

    prefill = "prefill_groups"
    checks["prefill_groups.active_name_unique"] = {
        "kind": "unique_key",
        "violations": count_query(
            conn,
            f"SELECT COUNT(*) FROM (SELECT 1 FROM {quote_ident(prefill)} "
            "WHERE deleted_at IS NULL GROUP BY name HAVING COUNT(*) > 1)",
        ),
    }
    invalid_prefill_items = 0
    for (items,) in conn.execute(
        f"SELECT items FROM {quote_ident(prefill)} WHERE items IS NOT NULL"
    ):
        try:
            normalize_json_text(items, prefill, "items")
        except ValueError:
            invalid_prefill_items += 1
    checks["prefill_groups.value_domain"] = {
        "kind": "domain_integrity",
        "violations": condition_count(
            conn,
            prefill,
            None,
            "id <= 0 OR name IS NULL OR TRIM(name) = '' OR type IS NULL "
            "OR TRIM(type) = '' OR description IS NULL OR created_time < 0 "
            "OR updated_time < 0",
        )
        + invalid_prefill_items,
    }
    return checks


def relationship_checks(conn, role):
    topups_table = "top_ups" if role == "source" else "topups"
    two_fa_table = "two_fas" if role == "source" else "two_fa"
    active_two_fa_child = "child.deleted_at IS NULL AND " if role == "source" else ""
    active_backup_child = "child.deleted_at IS NULL AND " if role == "source" else ""
    active_two_fa_parent = " AND parent.deleted_at IS NULL" if role == "source" else ""
    return {
        "tokens.user_id->users.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM tokens child "
                "LEFT JOIN users parent ON child.user_id = parent.id "
                "WHERE parent.id IS NULL",
            ),
        },
        "abilities.channel_id->channels.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM abilities child "
                "LEFT JOIN channels parent ON child.channel_id = parent.id "
                "WHERE parent.id IS NULL",
            ),
        },
        "topups.user_id->users.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                f"SELECT COUNT(*) FROM {quote_ident(topups_table)} child "
                "LEFT JOIN users parent ON child.user_id = parent.id "
                "WHERE parent.id IS NULL",
            ),
        },
        "passkey_credentials.user_id->users.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM passkey_credentials child "
                "LEFT JOIN users parent ON child.user_id = parent.id "
                "WHERE parent.id IS NULL",
            ),
        },
        "two_fa.user_id->users.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                f"SELECT COUNT(*) FROM {quote_ident(two_fa_table)} child "
                "LEFT JOIN users parent ON child.user_id = parent.id "
                f"WHERE {active_two_fa_child}parent.id IS NULL",
            ),
        },
        "two_fa_backup_codes.user_id->users.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM two_fa_backup_codes child "
                "LEFT JOIN users parent ON child.user_id = parent.id "
                f"WHERE {active_backup_child}parent.id IS NULL",
            ),
        },
        "two_fa_backup_codes.user_id->two_fa.user_id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM two_fa_backup_codes child "
                f"LEFT JOIN {quote_ident(two_fa_table)} parent "
                f"ON child.user_id = parent.user_id{active_two_fa_parent} "
                f"WHERE {active_backup_child}parent.id IS NULL",
            ),
        },
        "midjourneys.user_id->users.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM midjourneys child "
                "LEFT JOIN users parent ON child.user_id = parent.id "
                "WHERE parent.id IS NULL",
            ),
        },
        "midjourneys.channel_id->channels.id": {
            "kind": "foreign_key",
            "violations": count_query(
                conn,
                "SELECT COUNT(*) FROM midjourneys child "
                "LEFT JOIN channels parent ON child.channel_id = parent.id "
                "WHERE parent.id IS NULL",
            ),
        },
    }


def excluded_source_family_manifest(conn):
    existing = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    manifest = {}
    for decision in EXCLUDED_SOURCE_FAMILIES:
        table = decision["source"]
        base = {
            "decision": decision["decision"],
            "reason": decision["reason"],
            "replacement": decision["replacement"],
            "expected_columns": list(decision["columns"]),
        }
        if table not in existing:
            manifest[table] = {
                **base,
                "missing": True,
                "row_count": 0,
                "schema_sha256": None,
            }
            continue

        schema = table_schema(conn, table)
        missing = [column for column in decision["columns"] if column not in schema]
        if missing:
            raise ValueError(
                f"excluded source family {table} is missing audited columns: "
                + ", ".join(missing)
            )
        schema_signature = [
            {
                "name": column,
                "type": schema[column]["type"],
                "not_null": schema[column]["not_null"],
                "primary_key": schema[column]["primary_key"],
            }
            for column in decision["columns"]
        ]
        manifest[table] = {
            **base,
            "missing": False,
            "row_count": count_query(conn, f"SELECT COUNT(*) FROM {quote_ident(table)}"),
            "schema_sha256": hashlib.sha256(
                canonical_bytes(schema_signature)
            ).hexdigest(),
        }
    return manifest


def build_manifest(conn, role, target_schemas, sample_size):
    schemas = {
        spec["name"]: table_schema(conn, table_name(spec, role))
        for spec in TABLE_SPECS
    }
    tables = {}
    for spec in TABLE_SPECS:
        table = spec["name"]
        target_schema = target_schemas[table]
        missing_target = [name for name in spec["columns"] if name not in target_schema]
        if missing_target:
            raise ValueError(
                f"target table {table} is missing reconciliation columns: "
                + ", ".join(missing_target)
            )
        if role == "target":
            missing = [name for name in spec["columns"] if name not in schemas[table]]
            if missing:
                raise ValueError(
                    f"target table {table} is missing reconciliation columns: "
                    + ", ".join(missing)
                )
        tables[table] = table_manifest(
            conn,
            spec,
            role,
            schemas[table],
            target_schema,
            sample_size,
        )

    manifest = {
        "format": MANIFEST_FORMAT,
        "canonical_serialization": SERIALIZATION,
        "sample_algorithm": SAMPLE_ALGORITHM,
        "sample_size_limit": sample_size,
        "scope": [spec["name"] for spec in TABLE_SPECS],
        "tables": tables,
        "relationships": relationship_checks(conn, role),
        "integrity_checks": logical_key_checks(conn, role),
    }
    if role == "source":
        manifest["excluded_source_families"] = excluded_source_family_manifest(conn)
    return manifest


def compare_manifests(source, target):
    differences = []
    for table in source["scope"]:
        expected = source["tables"][table]
        actual = target["tables"][table]
        for field, label in (
            ("count", "row count"),
            ("pk_min", "logical PK minimum"),
            ("pk_max", "logical PK maximum"),
            ("sha256", "canonical SHA-256"),
        ):
            if expected[field] != actual[field]:
                differences.append(
                    f"table {table}: {label} differs "
                    f"(source={json.dumps(expected[field], ensure_ascii=False, separators=(',', ':'))}, "
                    f"target={json.dumps(actual[field], ensure_ascii=False, separators=(',', ':'))})"
                )

        expected_samples = {
            canonical_bytes(sample["pk"]): sample["row_sha256"]
            for sample in expected["samples"]
        }
        actual_samples = {
            canonical_bytes(sample["pk"]): sample["row_sha256"]
            for sample in actual["samples"]
        }
        if expected_samples != actual_samples:
            missing = len(expected_samples.keys() - actual_samples.keys())
            extra = len(actual_samples.keys() - expected_samples.keys())
            changed = sum(
                expected_samples[key] != actual_samples[key]
                for key in expected_samples.keys() & actual_samples.keys()
            )
            differences.append(
                f"table {table}: deterministic samples differ "
                f"(missing={missing}, extra={extra}, changed={changed})"
            )

    for section in ("relationships", "integrity_checks"):
        for name, source_check in source[section].items():
            target_check = target[section][name]
            if source_check["violations"]:
                differences.append(
                    f"source {section[:-1]} {name}: "
                    f"{source_check['violations']} violation(s)"
                )
            if target_check["violations"]:
                differences.append(
                    f"target {section[:-1]} {name}: "
                    f"{target_check['violations']} violation(s)"
                )
            if source_check != target_check:
                differences.append(
                    f"{section[:-1]} {name}: source and target check results differ"
                )
    return differences


def main():
    if len(sys.argv) != 4:
        raise ValueError("expected source path, target path, and sample size")
    source_path, target_path, sample_size_raw = sys.argv[1:]
    sample_size = int(sample_size_raw)
    if sample_size < 1:
        raise ValueError("sample size must be positive")

    source = open_read_only(source_path)
    target = open_read_only(target_path)
    try:
        source.execute("BEGIN")
        target.execute("BEGIN")
        target_schemas = {
            spec["name"]: table_schema(target, spec["name"]) for spec in TABLE_SPECS
        }
        source_manifest = build_manifest(source, "source", target_schemas, sample_size)
        target_manifest = build_manifest(target, "target", target_schemas, sample_size)
        result = {
            "format": RESULT_FORMAT,
            "source_manifest": source_manifest,
            "target_manifest": target_manifest,
            "differences": compare_manifests(source_manifest, target_manifest),
        }
        print(
            json.dumps(
                result,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        )
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"reconciliation engine failed: {error}", file=sys.stderr)
        sys.exit(3)
