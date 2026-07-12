import base64
import hashlib
import heapq
import json
import math
import sqlite3
import sys


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
    cursor = conn.execute(
        f"SELECT {select_sql} FROM {quote_ident(table_name(spec, role))} "
        f"ORDER BY {order_sql}"
    )
    names = [description[0] for description in cursor.description]
    return cursor, names


def project_row(spec, role, names, raw_row, target_schema):
    row = dict(zip(names, raw_row))
    projected = {}
    for target_column in spec["columns"]:
        if role == "target":
            projected[target_column] = row[target_column]
            continue

        if spec["name"] == "topups":
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

        name = source_column(spec, target_column)
        value = row.get(name)
        if name in row and value is not None:
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


def logical_key_checks(conn, role):
    checks = {}
    for spec in TABLE_SPECS:
        table = table_name(spec, role)
        keys = [
            source_column(spec, name) if role == "source" else name
            for name in spec["logical_pk"]
        ]
        key_sql = ", ".join(quote_ident(name) for name in keys)
        null_sql = " OR ".join(f"{quote_ident(name)} IS NULL" for name in keys)
        duplicate_groups = count_query(
            conn,
            f"SELECT COUNT(*) FROM ("
            f"SELECT 1 FROM {quote_ident(table)} GROUP BY {key_sql} HAVING COUNT(*) > 1"
            f")",
        )
        null_keys = count_query(
            conn,
            f"SELECT COUNT(*) FROM {quote_ident(table)} WHERE {null_sql}",
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
    return checks


def relationship_checks(conn, role):
    topups_table = "top_ups" if role == "source" else "topups"
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
    }


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

    return {
        "format": MANIFEST_FORMAT,
        "canonical_serialization": SERIALIZATION,
        "sample_algorithm": SAMPLE_ALGORITHM,
        "sample_size_limit": sample_size,
        "scope": [spec["name"] for spec in TABLE_SPECS],
        "tables": tables,
        "relationships": relationship_checks(conn, role),
        "integrity_checks": logical_key_checks(conn, role),
    }


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
