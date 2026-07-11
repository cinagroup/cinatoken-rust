use serde_json::{Map, Number, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{self, Command},
};

fn main() {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".to_string());
    let result = match command.as_str() {
        "dev-seed" => print_dev_seed(args.collect()),
        "inspect-source" => print_source_inspection(args.collect()),
        "export" => export_sqlite(args.collect()),
        "import" => import_d1_sql(args.collect()),
        "verify" => verify_migration(args.collect()),
        "reconcile" => reconcile_migration(args.collect()),
        "help" | "-h" | "--help" => {
            print_help();
            Ok(())
        }
        _ => Err(format!("unknown command: {command}")),
    };

    if let Err(err) = result {
        eprintln!("error: {err}");
        eprintln!();
        print_help();
        process::exit(2);
    }
}

fn print_help() {
    println!("cinatoken-migrate");
    println!();
    println!("Usage:");
    println!("  cinatoken-migrate dev-seed [options]");
    println!("  cinatoken-migrate inspect-source [options]");
    println!("  cinatoken-migrate export --sqlite <path> --output <path> [options]");
    println!("  cinatoken-migrate import --input <path> --output <path> [options]");
    println!("  cinatoken-migrate verify [options]");
    println!("  cinatoken-migrate reconcile --source <path> --target <path> [options]");
    println!();
    println!("dev-seed options:");
    println!("  --upstream-key <key>       upstream provider key, or CINATOKEN_DEV_UPSTREAM_KEY");
    println!("  --token-key <key>          local client token key, default ct-dev-key");
    println!("  --model <model>            model enabled on the dev channel, default gpt-4o-mini");
    println!("  --base-url <url>           upstream API base URL, default empty/provider default");
    println!("  --channel-type <number>    OpenAI-compatible channel type, default 1");
    println!("  --group <name>             user/token/channel group, default default");
    println!("  --output <path>            write SQL to a file instead of stdout");
    println!();
    println!("inspect-source options:");
    println!("  --repo <path>              source Go repository path, default current directory");
    println!("  --sqlite <path>            optional source SQLite database to count");
    println!();
    println!("export options:");
    println!("  --sqlite <path>            source SQLite database to export");
    println!("  --output <path>            JSON export path");
    println!("  --table <name>             export one known table; repeatable");
    println!("  --all                      export all known migration tables, including logs");
    println!();
    println!("import options:");
    println!("  --input <path>             JSON export bundle");
    println!("  --output <path>            generated D1 SQL path");
    println!("  --table <name>             import one supported D1 table; repeatable");
    println!("  --all                      import all supported D1 tables");
    println!("  --truncate                 delete selected D1 tables before insert");
    println!();
    println!("verify options:");
    println!("  --input <path>             JSON export bundle to validate");
    println!("  --sql <path>               generated D1 SQL to execute with SQLite");
    println!("  --schema <path>            D1 schema SQL, default migrations/d1/0001_core.sql");
    println!();
    println!("reconcile options:");
    println!("  --source <path>            authoritative source SQLite database");
    println!("  --target <path>            locally migrated D1-compatible SQLite database");
    println!("  --manifest-output <path>   write the deterministic v1 source manifest");
    println!("  --sample-size <number>     maximum samples per P0 table, default 1000");
}

fn print_dev_seed(args: Vec<String>) -> Result<(), String> {
    let config = DevSeedConfig::from_args(args)?;
    let sql = config.to_sql();
    if let Some(output) = config.output.as_deref() {
        write_output(output, &sql)?;
        eprintln!("wrote dev seed SQL to {output}");
    } else {
        println!("{sql}");
    }
    Ok(())
}

fn print_source_inspection(args: Vec<String>) -> Result<(), String> {
    let config = SourceInspectConfig::from_args(args)?;
    let statuses = source_marker_statuses(&config.repo);
    let candidates = candidate_sqlite_paths(&config.repo);

    println!("Source repository: {}", config.repo.display());
    println!();
    println!("Repository markers:");
    for status in statuses {
        let mark = if status.exists { "ok" } else { "missing" };
        println!("  [{mark}] {} ({})", status.label, status.relative_path);
    }

    println!();
    println!("SQLite candidates:");
    if candidates.is_empty() {
        println!("  none found in common locations");
    } else {
        for candidate in candidates {
            println!("  {}", candidate.display());
        }
    }

    let env_candidates = source_database_env_candidates();
    println!();
    println!("Database environment hints:");
    if env_candidates.is_empty() {
        println!("  SQL_DSN, LOG_SQL_DSN, SQLITE_PATH, and SQLITE_DSN are not set");
    } else {
        for candidate in env_candidates {
            println!("  {}={}", candidate.name, candidate.value);
        }
    }

    if let Some(sqlite) = config.sqlite.as_deref() {
        println!();
        println!("{}", sqlite_table_counts(sqlite)?);
    }

    Ok(())
}

fn export_sqlite(args: Vec<String>) -> Result<(), String> {
    let config = ExportConfig::from_args(args)?;
    let summary = export_sqlite_json(&config)?;
    println!("{summary}");
    Ok(())
}

fn import_d1_sql(args: Vec<String>) -> Result<(), String> {
    let config = ImportConfig::from_args(args)?;
    let bundle = fs::read_to_string(&config.input)
        .map_err(|err| format!("failed to read {}: {err}", config.input.display()))?;
    let sql = render_d1_import_sql(&bundle, &config.tables, config.truncate)?;
    write_output(
        config.output.to_str().ok_or_else(|| {
            format!(
                "output path is not valid UTF-8: {}",
                config.output.display()
            )
        })?,
        &sql,
    )?;
    println!("Generated D1 import SQL at {}", config.output.display());
    println!("Tables: {}", config.tables.join(", "));
    Ok(())
}

fn verify_migration(args: Vec<String>) -> Result<(), String> {
    let config = VerifyConfig::from_args(args)?;
    if let Some(input) = config.input.as_deref() {
        let bundle = fs::read_to_string(input)
            .map_err(|err| format!("failed to read {}: {err}", input.display()))?;
        println!("{}", verify_export_bundle(&bundle)?);
    }
    if let Some(sql) = config.sql.as_deref() {
        println!("{}", verify_d1_sql_with_sqlite(&config.schema, sql)?);
    }
    Ok(())
}

fn reconcile_migration(args: Vec<String>) -> Result<(), String> {
    let config = ReconcileConfig::from_args(args)?;
    let result = reconcile_sqlite_databases(&config)?;
    let manifest = result
        .get("source_manifest")
        .ok_or_else(|| "reconciliation result is missing source_manifest".to_string())?;

    if let Some(output) = config.manifest_output.as_deref() {
        ensure_parent_dir(output)?;
        let mut encoded = serde_json::to_string_pretty(manifest)
            .map_err(|err| format!("failed to encode reconciliation manifest: {err}"))?;
        encoded.push('\n');
        fs::write(output, encoded)
            .map_err(|err| format!("failed to write {}: {err}", output.display()))?;
    }

    let differences = result
        .get("differences")
        .and_then(Value::as_array)
        .ok_or_else(|| "reconciliation result is missing differences array".to_string())?;
    if !differences.is_empty() {
        let details = differences
            .iter()
            .map(|difference| {
                difference
                    .as_str()
                    .map(|difference| format!("  - {difference}"))
                    .ok_or_else(|| {
                        "reconciliation result contains a non-string difference".to_string()
                    })
            })
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        let manifest_note = config
            .manifest_output
            .as_deref()
            .map(|path| format!("\nExpected manifest: {}", path.display()))
            .unwrap_or_default();
        return Err(format!(
            "P0 source-to-D1 reconciliation failed with {} drift(s):\n{details}{manifest_note}",
            differences.len()
        ));
    }

    let tables = manifest
        .get("tables")
        .and_then(Value::as_object)
        .ok_or_else(|| "reconciliation manifest is missing tables object".to_string())?;
    println!("P0 source-to-D1 reconciliation passed");
    println!("Manifest: cinatoken-source-to-d1-reconciliation-v1");
    println!("Tables:");
    for table in D1_CORE_IMPORT_TABLES {
        let table_manifest = tables
            .get(*table)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("reconciliation manifest is missing table {table}"))?;
        let count = table_manifest
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("reconciliation manifest table {table} has no count"))?;
        let sha256 = table_manifest
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("reconciliation manifest table {table} has no SHA-256"))?;
        println!("  {table}: {count} rows, sha256={sha256}");
    }
    println!("Relationship and integrity checks: passed");
    if let Some(output) = config.manifest_output.as_deref() {
        println!("Manifest written to {}", output.display());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DevSeedConfig {
    upstream_key: String,
    token_key: String,
    model: String,
    base_url: String,
    channel_type: i32,
    group: String,
    output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceInspectConfig {
    repo: PathBuf,
    sqlite: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExportConfig {
    sqlite: PathBuf,
    output: PathBuf,
    tables: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ImportConfig {
    input: PathBuf,
    output: PathBuf,
    tables: Vec<String>,
    truncate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifyConfig {
    input: Option<PathBuf>,
    sql: Option<PathBuf>,
    schema: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReconcileConfig {
    source: PathBuf,
    target: PathBuf,
    manifest_output: Option<PathBuf>,
    sample_size: usize,
}

impl SourceInspectConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut config = Self {
            repo: env::current_dir()
                .map_err(|err| format!("failed to resolve current directory: {err}"))?,
            sqlite: None,
        };

        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            match flag.as_str() {
                "--repo" => config.repo = PathBuf::from(next_value(&mut iter, &flag)?),
                "--sqlite" => config.sqlite = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--" => {}
                "-h" | "--help" => {
                    print_help();
                    process::exit(0);
                }
                _ => return Err(format!("unknown inspect-source option: {flag}")),
            }
        }

        if !config.repo.exists() {
            return Err(format!(
                "source repository does not exist: {}",
                config.repo.display()
            ));
        }
        if !config.repo.is_dir() {
            return Err(format!(
                "source repository is not a directory: {}",
                config.repo.display()
            ));
        }
        if let Some(sqlite) = config.sqlite.as_deref() {
            if !sqlite.exists() {
                return Err(format!(
                    "source SQLite database does not exist: {}",
                    sqlite.display()
                ));
            }
            if !sqlite.is_file() {
                return Err(format!(
                    "source SQLite database is not a file: {}",
                    sqlite.display()
                ));
            }
        }

        Ok(config)
    }
}

impl ExportConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut sqlite = None;
        let mut output = None;
        let mut tables = Vec::new();
        let mut export_all = false;

        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            match flag.as_str() {
                "--sqlite" => sqlite = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--output" => output = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--table" => tables.push(next_value(&mut iter, &flag)?),
                "--all" => export_all = true,
                "--" => {}
                "-h" | "--help" => {
                    print_help();
                    process::exit(0);
                }
                _ => return Err(format!("unknown export option: {flag}")),
            }
        }

        if export_all && !tables.is_empty() {
            return Err("--all cannot be combined with --table".to_string());
        }

        let sqlite = sqlite.ok_or_else(|| "export requires --sqlite <path>".to_string())?;
        if !sqlite.exists() {
            return Err(format!(
                "source SQLite database does not exist: {}",
                sqlite.display()
            ));
        }
        if !sqlite.is_file() {
            return Err(format!(
                "source SQLite database is not a file: {}",
                sqlite.display()
            ));
        }

        let output = output.ok_or_else(|| "export requires --output <path>".to_string())?;
        if output.as_os_str().is_empty() {
            return Err("--output cannot be empty".to_string());
        }

        let tables = if export_all {
            SOURCE_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect()
        } else if tables.is_empty() {
            CORE_EXPORT_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect()
        } else {
            validate_export_tables(tables)?
        };

        Ok(Self {
            sqlite,
            output,
            tables,
        })
    }
}

impl ImportConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut input = None;
        let mut output = None;
        let mut tables = Vec::new();
        let mut import_all = false;
        let mut truncate = false;

        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            match flag.as_str() {
                "--input" => input = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--output" => output = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--table" => tables.push(next_value(&mut iter, &flag)?),
                "--all" => import_all = true,
                "--truncate" => truncate = true,
                "--" => {}
                "-h" | "--help" => {
                    print_help();
                    process::exit(0);
                }
                _ => return Err(format!("unknown import option: {flag}")),
            }
        }

        if import_all && !tables.is_empty() {
            return Err("--all cannot be combined with --table".to_string());
        }

        let input = input.ok_or_else(|| "import requires --input <path>".to_string())?;
        if !input.exists() {
            return Err(format!(
                "JSON export bundle does not exist: {}",
                input.display()
            ));
        }
        if !input.is_file() {
            return Err(format!(
                "JSON export bundle is not a file: {}",
                input.display()
            ));
        }

        let output = output.ok_or_else(|| "import requires --output <path>".to_string())?;
        if output.as_os_str().is_empty() {
            return Err("--output cannot be empty".to_string());
        }

        let tables = if import_all {
            D1_IMPORT_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect()
        } else if tables.is_empty() {
            D1_CORE_IMPORT_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect()
        } else {
            validate_import_tables(tables)?
        };

        Ok(Self {
            input,
            output,
            tables,
            truncate,
        })
    }
}

impl VerifyConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut config = Self {
            input: None,
            sql: None,
            schema: PathBuf::from("migrations/d1/0001_core.sql"),
        };

        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            match flag.as_str() {
                "--input" => config.input = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--sql" => config.sql = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--schema" => config.schema = PathBuf::from(next_value(&mut iter, &flag)?),
                "--" => {}
                "-h" | "--help" => {
                    print_help();
                    process::exit(0);
                }
                _ => return Err(format!("unknown verify option: {flag}")),
            }
        }

        if config.input.is_none() && config.sql.is_none() {
            return Err("verify requires --input <path>, --sql <path>, or both".to_string());
        }
        if let Some(input) = config.input.as_deref() {
            ensure_existing_file(input, "JSON export bundle")?;
        }
        if let Some(sql) = config.sql.as_deref() {
            ensure_existing_file(sql, "generated D1 SQL")?;
            ensure_existing_file(&config.schema, "D1 schema SQL")?;
        }

        Ok(config)
    }
}

impl ReconcileConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        let mut source = None;
        let mut target = None;
        let mut manifest_output = None;
        let mut sample_size = 1_000usize;

        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            match flag.as_str() {
                "--source" => source = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--target" => target = Some(PathBuf::from(next_value(&mut iter, &flag)?)),
                "--manifest-output" => {
                    manifest_output = Some(PathBuf::from(next_value(&mut iter, &flag)?))
                }
                "--sample-size" => {
                    let value = next_value(&mut iter, &flag)?;
                    sample_size = value.parse::<usize>().map_err(|_| {
                        format!("--sample-size must be a positive integer, got {value}")
                    })?;
                }
                "--" => {}
                "-h" | "--help" => {
                    print_help();
                    process::exit(0);
                }
                _ => return Err(format!("unknown reconcile option: {flag}")),
            }
        }

        let source = source.ok_or_else(|| "reconcile requires --source <path>".to_string())?;
        let target = target.ok_or_else(|| "reconcile requires --target <path>".to_string())?;
        ensure_existing_file(&source, "source SQLite database")?;
        ensure_existing_file(&target, "target SQLite database")?;
        let canonical_source = fs::canonicalize(&source)
            .map_err(|err| format!("failed to resolve {}: {err}", source.display()))?;
        let canonical_target = fs::canonicalize(&target)
            .map_err(|err| format!("failed to resolve {}: {err}", target.display()))?;
        if canonical_source == canonical_target {
            return Err("--source and --target must be different SQLite databases".to_string());
        }
        if !(1..=10_000).contains(&sample_size) {
            return Err("--sample-size must be between 1 and 10000".to_string());
        }
        if matches!(
            manifest_output
                .as_deref()
                .and_then(Path::to_str)
                .map(str::trim),
            Some("")
        ) {
            return Err("--manifest-output cannot be empty".to_string());
        }
        if let Some(output) = manifest_output.as_deref().filter(|path| path.exists()) {
            if !output.is_file() {
                return Err(format!(
                    "reconciliation manifest output is not a file: {}",
                    output.display()
                ));
            }
            let canonical_output = fs::canonicalize(output)
                .map_err(|err| format!("failed to resolve {}: {err}", output.display()))?;
            if canonical_output == canonical_source || canonical_output == canonical_target {
                return Err(
                    "--manifest-output must not overwrite the source or target database"
                        .to_string(),
                );
            }
        }

        Ok(Self {
            source,
            target,
            manifest_output,
            sample_size,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceMarkerStatus {
    label: &'static str,
    relative_path: &'static str,
    exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EnvCandidate {
    name: &'static str,
    value: String,
}

const SOURCE_MARKERS: &[(&str, &str)] = &[
    ("Go module", "go.mod"),
    ("GORM database bootstrap", "model/main.go"),
    ("user model", "model/user.go"),
    ("token model", "model/token.go"),
    ("channel model", "model/channel.go"),
    ("ability model", "model/ability.go"),
    ("relay adapters", "relay/channel"),
    ("billing expression docs", "pkg/billingexpr/expr.md"),
    ("default frontend", "web/default/package.json"),
];

const SQLITE_CANDIDATE_RELS: &[&str] = &[
    "one-api.db",
    "one-api.sqlite",
    "one-api.sqlite3",
    "cinatoken.db",
    "cinatoken.sqlite",
    "cinatoken.sqlite3",
    "new-api.db",
    "data/one-api.db",
    "data/one-api.sqlite",
    "data/one-api.sqlite3",
    "data/cinatoken.db",
    "data/cinatoken.sqlite",
    "data/cinatoken.sqlite3",
    "data/new-api.db",
];

const SOURCE_TABLES: &[&str] = &[
    "users",
    "tokens",
    "channels",
    "abilities",
    "options",
    "logs",
    "quota_data",
    "tasks",
    "models",
    "vendors",
    "redemptions",
    "top_ups",
    "midjourneys",
    "passkey_credentials",
    "prefill_groups",
    "setups",
    "two_fas",
    "two_fa_backup_codes",
    "checkins",
    "subscription_plans",
    "subscription_orders",
    "user_subscriptions",
    "subscription_pre_consume_records",
    "custom_oauth_providers",
    "user_oauth_bindings",
    "perf_metrics",
];

const CORE_EXPORT_TABLES: &[&str] = &[
    "users",
    "tokens",
    "channels",
    "abilities",
    "options",
    "models",
    "vendors",
    "prefill_groups",
    "setups",
];

const D1_IMPORT_TABLES: &[&str] = &[
    "users",
    "tokens",
    "channels",
    "abilities",
    "options",
    "logs",
    "tasks",
    "checkins",
    "redemptions",
    "subscription_plans",
    "subscription_orders",
    "user_subscriptions",
    "subscription_pre_consume_records",
    "vendors",
    "models",
    "custom_oauth_providers",
    "user_oauth_bindings",
];

const D1_CORE_IMPORT_TABLES: &[&str] = &["users", "tokens", "channels", "abilities", "options"];

const RECONCILIATION_RESULT_FORMAT: &str = "cinatoken-source-to-d1-reconciliation-result-v1";
const RECONCILE_SQLITE_SCRIPT: &str = include_str!("../scripts/reconcile_sqlite.py");

const USERS_D1_COLUMNS: &[&str] = &[
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
];

const TOKENS_D1_COLUMNS: &[&str] = &[
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
];

const CHANNELS_D1_COLUMNS: &[&str] = &[
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
];

const ABILITIES_D1_COLUMNS: &[&str] = &[
    "id",
    "group_name",
    "model",
    "channel_id",
    "enabled",
    "priority",
    "weight",
    "tag",
];

const OPTIONS_D1_COLUMNS: &[&str] = &["id", "key", "value"];

const LOGS_D1_COLUMNS: &[&str] = &[
    "id",
    "user_id",
    "created_at",
    "type",
    "content",
    "username",
    "token_name",
    "model_name",
    "quota",
    "prompt_tokens",
    "completion_tokens",
    "use_time",
    "is_stream",
    "channel_id",
    "token_id",
    "group",
    "ip",
    "request_id",
    "upstream_request_id",
    "other",
];

const TASKS_D1_COLUMNS: &[&str] = &[
    "id",
    "task_id",
    "upstream_task_id",
    "platform",
    "user_id",
    "username",
    "group",
    "channel_id",
    "quota",
    "action",
    "status",
    "fail_reason",
    "progress",
    "submit_time",
    "start_time",
    "finish_time",
    "properties",
    "private_data",
    "data",
    "created_at",
    "updated_at",
];

const CHECKINS_D1_COLUMNS: &[&str] = &[
    "id",
    "user_id",
    "checkin_date",
    "quota_awarded",
    "created_at",
];

const REDEMPTIONS_D1_COLUMNS: &[&str] = &[
    "id",
    "user_id",
    "key",
    "status",
    "name",
    "quota",
    "created_time",
    "redeemed_time",
    "used_user_id",
    "expired_time",
    "deleted_at",
    "credited",
];

const SUBSCRIPTION_PLANS_D1_COLUMNS: &[&str] = &[
    "id",
    "title",
    "subtitle",
    "price_amount",
    "currency",
    "duration_unit",
    "duration_value",
    "custom_seconds",
    "enabled",
    "sort_order",
    "allow_balance_pay",
    "stripe_price_id",
    "creem_product_id",
    "waffo_pancake_product_id",
    "max_purchase_per_user",
    "upgrade_group",
    "total_amount",
    "quota_reset_period",
    "quota_reset_custom_seconds",
    "created_at",
    "updated_at",
];

const SUBSCRIPTION_ORDERS_D1_COLUMNS: &[&str] = &[
    "id",
    "user_id",
    "provider",
    "order_no",
    "plan_id",
    "status",
    "amount",
    "currency",
    "created_at",
    "updated_at",
    "money",
    "trade_no",
    "payment_method",
    "payment_provider",
    "create_time",
    "complete_time",
    "provider_payload",
];

const SUBSCRIPTION_ORDERS_D1_COLUMN_MAP: &[(&str, &str)] = &[
    ("provider", "payment_provider"),
    ("order_no", "trade_no"),
    ("amount", "money"),
    ("created_at", "create_time"),
    ("updated_at", "complete_time"),
];

const USER_SUBSCRIPTIONS_D1_COLUMNS: &[&str] = &[
    "id",
    "user_id",
    "plan_id",
    "amount_total",
    "amount_used",
    "start_time",
    "end_time",
    "status",
    "source",
    "last_reset_time",
    "next_reset_time",
    "upgrade_group",
    "prev_user_group",
    "created_at",
    "updated_at",
];

const SUBSCRIPTION_PRE_CONSUME_RECORDS_D1_COLUMNS: &[&str] = &[
    "id",
    "request_id",
    "user_id",
    "user_subscription_id",
    "pre_consumed",
    "status",
    "created_at",
    "updated_at",
];

const VENDORS_D1_COLUMNS: &[&str] = &[
    "id",
    "name",
    "description",
    "icon",
    "status",
    "created_time",
    "updated_time",
    "deleted_at",
];

const MODELS_D1_COLUMNS: &[&str] = &[
    "id",
    "model_name",
    "description",
    "icon",
    "tags",
    "vendor_id",
    "endpoints",
    "status",
    "sync_official",
    "created_time",
    "updated_time",
    "name_rule",
    "deleted_at",
];

const CUSTOM_OAUTH_PROVIDERS_D1_COLUMNS: &[&str] = &[
    "id",
    "name",
    "slug",
    "icon",
    "enabled",
    "client_id",
    "client_secret",
    "authorization_endpoint",
    "token_endpoint",
    "user_info_endpoint",
    "scopes",
    "user_id_field",
    "username_field",
    "display_name_field",
    "email_field",
    "well_known",
    "auth_style",
    "access_policy",
    "access_denied_message",
    "created_at",
    "updated_at",
];

const USER_OAUTH_BINDINGS_D1_COLUMNS: &[&str] = &[
    "id",
    "user_id",
    "provider_id",
    "provider_user_id",
    "created_at",
];

impl DevSeedConfig {
    fn from_args(args: Vec<String>) -> Result<Self, String> {
        Self::from_args_with_env(args, env::var("CINATOKEN_DEV_UPSTREAM_KEY").ok())
    }

    fn from_args_with_env(
        args: Vec<String>,
        upstream_key_env: Option<String>,
    ) -> Result<Self, String> {
        let mut config = Self {
            upstream_key: upstream_key_env.unwrap_or_default(),
            token_key: "ct-dev-key".to_string(),
            model: "gpt-4o-mini".to_string(),
            base_url: String::new(),
            channel_type: 1,
            group: "default".to_string(),
            output: None,
        };

        let mut iter = args.into_iter();
        while let Some(flag) = iter.next() {
            match flag.as_str() {
                "--upstream-key" => config.upstream_key = next_value(&mut iter, &flag)?,
                "--token-key" => config.token_key = next_value(&mut iter, &flag)?,
                "--model" => config.model = next_value(&mut iter, &flag)?,
                "--base-url" => config.base_url = next_value(&mut iter, &flag)?,
                "--channel-type" => {
                    let value = next_value(&mut iter, &flag)?;
                    config.channel_type = value
                        .parse::<i32>()
                        .map_err(|_| format!("--channel-type must be an integer, got {value}"))?;
                }
                "--group" => config.group = next_value(&mut iter, &flag)?,
                "--output" => config.output = Some(next_value(&mut iter, &flag)?),
                "--" => {}
                "-h" | "--help" => {
                    print_help();
                    process::exit(0);
                }
                _ => return Err(format!("unknown dev-seed option: {flag}")),
            }
        }

        if config.upstream_key.trim().is_empty() {
            return Err(
                "dev-seed requires --upstream-key or CINATOKEN_DEV_UPSTREAM_KEY".to_string(),
            );
        }
        if config.token_key.trim().is_empty() {
            return Err("--token-key cannot be empty".to_string());
        }
        if config.model.trim().is_empty() {
            return Err("--model cannot be empty".to_string());
        }
        if config.group.trim().is_empty() {
            return Err("--group cannot be empty".to_string());
        }
        if matches!(config.output.as_deref().map(str::trim), Some("")) {
            return Err("--output cannot be empty".to_string());
        }

        Ok(config)
    }

    fn to_sql(&self) -> String {
        let group = sql_string(&self.group);
        let model = sql_string(&self.model);
        let token_key = sql_string(&self.token_key);
        let upstream_key = sql_string(&self.upstream_key);
        let base_url = sql_string(&self.base_url);

        format!(
            r#"-- Development seed for local D1 testing.
-- Client token: {token_key_comment}

INSERT OR REPLACE INTO users (
  id, username, password, display_name, role, status, email,
  quota, used_quota, request_count, "group", aff_code, created_at
) VALUES (
  1, 'dev', 'not-used', 'Developer', 10, 1, 'dev@example.test',
  100000000, 0, 0, {group}, 'dev-aff', strftime('%s','now')
);

INSERT OR REPLACE INTO tokens (
  id, user_id, "key", status, name, created_time, accessed_time,
  expired_time, remain_quota, unlimited_quota, model_limits_enabled,
  model_limits, allow_ips, "group"
) VALUES (
  1, 1, {token_key}, 1, 'dev-token', strftime('%s','now'), 0,
  -1, 100000000, 0, 0, '', '', {group}
);

INSERT OR REPLACE INTO channels (
  id, type, "key", status, name, created_time, base_url,
  models, "group", model_mapping, channel_info, settings
) VALUES (
  1, {channel_type}, {upstream_key}, 1, 'dev-openai-compatible',
  strftime('%s','now'), {base_url}, {model}, {group}, NULL, '{{}}', '{{}}'
);

INSERT OR REPLACE INTO abilities (
  id, group_name, model, channel_id, enabled, priority, weight
) VALUES (
  1, {group}, {model}, 1, 1, 0, 100
);
"#,
            token_key_comment = self.token_key,
            channel_type = self.channel_type,
        )
    }
}

fn next_value(iter: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    iter.next()
        .ok_or_else(|| format!("{flag} requires a value"))
        .map(|value| value.trim().to_string())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn write_output(path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(path);
    ensure_parent_dir(path)?;
    fs::write(path, content).map_err(|err| format!("failed to write {}: {err}", path.display()))
}

fn ensure_existing_file(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{label} does not exist: {}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("{label} is not a file: {}", path.display()));
    }
    Ok(())
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create {}: {err}", parent.display()))?;
    }
    Ok(())
}

fn source_marker_statuses(repo: &Path) -> Vec<SourceMarkerStatus> {
    SOURCE_MARKERS
        .iter()
        .map(|(label, relative_path)| SourceMarkerStatus {
            label: *label,
            relative_path: *relative_path,
            exists: repo.join(*relative_path).exists(),
        })
        .collect()
}

fn candidate_sqlite_paths(repo: &Path) -> Vec<PathBuf> {
    SQLITE_CANDIDATE_RELS
        .iter()
        .map(|relative_path| repo.join(relative_path))
        .filter(|path| path.is_file())
        .collect()
}

fn source_database_env_candidates() -> Vec<EnvCandidate> {
    ["SQL_DSN", "LOG_SQL_DSN", "SQLITE_PATH", "SQLITE_DSN"]
        .into_iter()
        .filter_map(|name| {
            env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| EnvCandidate { name, value })
        })
        .collect()
}

fn sqlite_table_counts(sqlite: &Path) -> Result<String, String> {
    let table_literal = SOURCE_TABLES
        .iter()
        .map(|table| format!("{table:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"
import sqlite3
import sys

tables = [{table_literal}]
path = sys.argv[1]
conn = sqlite3.connect(path)
print(f"SQLite database: {{path}}")
print("Table counts:")
for table in tables:
    quoted = '"' + table.replace('"', '""') + '"'
    try:
        count = conn.execute(f"SELECT COUNT(*) FROM {{quoted}}").fetchone()[0]
        print(f"  {{table}}: {{count}}")
    except sqlite3.Error:
        print(f"  {{table}}: missing")
"#,
        table_literal = table_literal
    );
    let output = Command::new("python")
        .arg("-c")
        .arg(script)
        .arg(sqlite)
        .output()
        .map_err(|err| format!("failed to run python sqlite inspection: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "sqlite inspection failed: {}{}",
            stdout.trim_end(),
            stderr.trim_end()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn verify_export_bundle(bundle: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(bundle).map_err(|err| format!("invalid export JSON: {err}"))?;
    let format = value
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(|| "export JSON is missing format".to_string())?;
    if format != "cinatoken-sqlite-export-v1" {
        return Err(format!("unsupported export format: {format}"));
    }

    let tables = value
        .get("tables")
        .and_then(Value::as_object)
        .ok_or_else(|| "export JSON is missing tables object".to_string())?;
    if tables.is_empty() {
        return Err("export JSON does not contain any tables".to_string());
    }

    let mut summary = String::from("Export bundle verified\nTables:\n");
    for (name, table) in tables {
        if !SOURCE_TABLES.contains(&name.as_str()) {
            summary.push_str(&format!("  {name}: unknown table in bundle\n"));
            continue;
        }
        let table = table
            .as_object()
            .ok_or_else(|| format!("table {name} is not an object"))?;
        if table
            .get("missing")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            summary.push_str(&format!("  {name}: missing\n"));
            continue;
        }
        let columns = table
            .get("columns")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("table {name} is missing columns array"))?;
        if !columns.iter().all(Value::is_string) {
            return Err(format!("table {name} columns must be strings"));
        }
        let rows = table
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("table {name} is missing rows array"))?;
        for (index, row) in rows.iter().enumerate() {
            if !row.is_object() {
                return Err(format!("table {name} row {} is not an object", index + 1));
            }
        }
        summary.push_str(&format!("  {name}: {} rows\n", rows.len()));
    }

    let present_core = D1_CORE_IMPORT_TABLES
        .iter()
        .filter(|table| {
            tables
                .get(**table)
                .and_then(Value::as_object)
                .map(|table| {
                    !table
                        .get("missing")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .unwrap_or(false)
        })
        .count();
    summary.push_str(&format!(
        "Core D1 tables present: {present_core}/{}\n",
        D1_CORE_IMPORT_TABLES.len()
    ));
    Ok(summary.trim_end().to_string())
}

fn verify_d1_sql_with_sqlite(schema: &Path, sql: &Path) -> Result<String, String> {
    let table_literal = D1_IMPORT_TABLES
        .iter()
        .map(|table| format!("{table:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"
import sqlite3
import sys

tables = [{table_literal}]
schema_path = sys.argv[1]
sql_path = sys.argv[2]

conn = sqlite3.connect(":memory:")
with open(schema_path, "r", encoding="utf-8") as schema_file:
    conn.executescript(schema_file.read())
with open(sql_path, "r", encoding="utf-8") as sql_file:
    conn.executescript(sql_file.read())

print(f"D1 SQL verified with SQLite: {{sql_path}}")
print("Table counts:")
for table in tables:
    quoted = '"' + table.replace('"', '""') + '"'
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    if row is None:
        print(f"  {{table}}: missing")
        continue
    count = conn.execute(f"SELECT COUNT(*) FROM {{quoted}}").fetchone()[0]
    print(f"  {{table}}: {{count}}")
"#,
        table_literal = table_literal
    );
    let output = Command::new("python")
        .arg("-c")
        .arg(script)
        .arg(schema)
        .arg(sql)
        .output()
        .map_err(|err| format!("failed to run python D1 SQL verification: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "D1 SQL verification failed: {}{}",
            stdout.trim_end(),
            stderr.trim_end()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn reconcile_sqlite_databases(config: &ReconcileConfig) -> Result<Value, String> {
    let output = Command::new("python")
        .arg("-c")
        .arg(RECONCILE_SQLITE_SCRIPT)
        .arg(&config.source)
        .arg(&config.target)
        .arg(config.sample_size.to_string())
        .output()
        .map_err(|err| format!("failed to run Python reconciliation engine: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "SQLite reconciliation engine failed: {}{}",
            stdout.trim_end(),
            stderr.trim_end()
        ));
    }

    let result: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("reconciliation engine returned invalid JSON: {err}"))?;
    let format = result
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(|| "reconciliation result is missing format".to_string())?;
    if format != RECONCILIATION_RESULT_FORMAT {
        return Err(format!(
            "unsupported reconciliation result format: {format}"
        ));
    }
    Ok(result)
}

fn validate_export_tables(tables: Vec<String>) -> Result<Vec<String>, String> {
    let mut validated = Vec::new();
    for table in tables {
        let table = table.trim().to_string();
        if table.is_empty() {
            return Err("--table cannot be empty".to_string());
        }
        if !SOURCE_TABLES.contains(&table.as_str()) {
            return Err(format!("unknown export table: {table}"));
        }
        if !validated.contains(&table) {
            validated.push(table);
        }
    }
    Ok(validated)
}

fn validate_import_tables(tables: Vec<String>) -> Result<Vec<String>, String> {
    let mut validated = Vec::new();
    for table in tables {
        let table = table.trim().to_string();
        if table.is_empty() {
            return Err("--table cannot be empty".to_string());
        }
        if !D1_IMPORT_TABLES.contains(&table.as_str()) {
            return Err(format!("unsupported D1 import table: {table}"));
        }
        if !validated.contains(&table) {
            validated.push(table);
        }
    }
    Ok(validated)
}

fn export_sqlite_json(config: &ExportConfig) -> Result<String, String> {
    ensure_parent_dir(&config.output)?;
    let table_literal = config
        .tables
        .iter()
        .map(|table| format!("{table:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!(
        r#"
import base64
import json
import sqlite3
import sys
import time

tables = [{table_literal}]
source_path = sys.argv[1]
output_path = sys.argv[2]

def quote_ident(name):
    return '"' + name.replace('"', '""') + '"'

def normalize(value):
    if isinstance(value, bytes):
        return {{"__blob_base64": base64.b64encode(value).decode("ascii")}}
    return value

conn = sqlite3.connect(source_path)
existing = {{
    row[0]
    for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
}}
payload = {{
    "format": "cinatoken-sqlite-export-v1",
    "generated_at": int(time.time()),
    "source": {{"kind": "sqlite", "path": source_path}},
    "tables": {{}},
}}

for table in tables:
    if table not in existing:
        payload["tables"][table] = {{
            "missing": True,
            "columns": [],
            "rows": [],
        }}
        continue

    cursor = conn.execute(f"SELECT * FROM {{quote_ident(table)}} LIMIT 0")
    columns = [column[0] for column in cursor.description]
    preferred_order = {{
        "abilities": ["group", "model", "channel_id"],
        "options": ["key"],
    }}.get(table, ["id"] if "id" in columns else columns)
    order_columns = [column for column in preferred_order if column in columns]
    order_sql = ", ".join(quote_ident(column) for column in order_columns)
    query = f"SELECT * FROM {{quote_ident(table)}}"
    if order_sql:
        query += f" ORDER BY {{order_sql}}"
    cursor = conn.execute(query)
    rows = [
        dict(zip(columns, [normalize(value) for value in row]))
        for row in cursor.fetchall()
    ]
    payload["tables"][table] = {{
        "missing": False,
        "columns": columns,
        "rows": rows,
    }}

with open(output_path, "w", encoding="utf-8") as export_file:
    json.dump(payload, export_file, ensure_ascii=False, indent=2)
    export_file.write("\n")

print(f"Exported SQLite data to {{output_path}}")
for table in tables:
    table_payload = payload["tables"][table]
    if table_payload["missing"]:
        print(f"  {{table}}: missing")
    else:
        print(f"  {{table}}: {{len(table_payload['rows'])}} rows")
"#,
        table_literal = table_literal
    );
    let output = Command::new("python")
        .arg("-c")
        .arg(script)
        .arg(&config.sqlite)
        .arg(&config.output)
        .output()
        .map_err(|err| format!("failed to run python sqlite export: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "sqlite export failed: {}{}",
            stdout.trim_end(),
            stderr.trim_end()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn render_d1_import_sql(bundle: &str, tables: &[String], truncate: bool) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(bundle).map_err(|err| format!("invalid export JSON: {err}"))?;
    let format = value
        .get("format")
        .and_then(Value::as_str)
        .ok_or_else(|| "export JSON is missing format".to_string())?;
    if format != "cinatoken-sqlite-export-v1" {
        return Err(format!("unsupported export format: {format}"));
    }

    let export_tables = value
        .get("tables")
        .and_then(Value::as_object)
        .ok_or_else(|| "export JSON is missing tables object".to_string())?;

    let mut sql = String::new();
    sql.push_str("-- Generated by cinatoken-migrate import.\n");
    sql.push_str("-- Review this SQL before applying it to Cloudflare D1.\n");
    sql.push_str("BEGIN TRANSACTION;\n\n");

    for table in tables {
        let spec = d1_table_spec(table)?;
        let Some(export_table) = export_tables
            .get(spec.source_name)
            .and_then(Value::as_object)
        else {
            sql.push_str(&format!(
                "-- Skipped {table}: source table {} is not present in export.\n\n",
                spec.source_name
            ));
            continue;
        };

        if export_table
            .get("missing")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            sql.push_str(&format!(
                "-- Skipped {table}: source table {} was missing.\n\n",
                spec.source_name
            ));
            continue;
        }

        let rows = export_table
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("source table {} is missing rows array", spec.source_name))?;

        sql.push_str(&format!("-- Table: {table} ({} rows)\n", rows.len()));
        if truncate {
            sql.push_str(&format!("DELETE FROM {};\n", quote_ident(spec.target_name)));
        }

        for (index, row) in rows.iter().enumerate() {
            let row = row
                .as_object()
                .ok_or_else(|| format!("source table {} has a non-object row", spec.source_name))?;
            let projected = project_d1_row(spec, row, index)?;
            if projected.is_empty() {
                sql.push_str(&format!(
                    "-- Skipped empty row {} from source table {}.\n",
                    index + 1,
                    spec.source_name
                ));
                continue;
            }

            let columns = projected
                .iter()
                .map(|(column, _)| quote_ident(column))
                .collect::<Vec<_>>()
                .join(", ");
            let values = projected
                .iter()
                .map(|(_, value)| sql_literal(value))
                .collect::<Vec<_>>()
                .join(", ");
            sql.push_str(&format!(
                "INSERT OR REPLACE INTO {} ({columns}) VALUES ({values});\n",
                quote_ident(spec.target_name)
            ));
        }
        sql.push('\n');
    }

    sql.push_str("COMMIT;\n");
    Ok(sql)
}

#[derive(Debug, Clone, Copy)]
struct D1TableSpec {
    source_name: &'static str,
    target_name: &'static str,
    target_columns: &'static [&'static str],
    column_map: &'static [(&'static str, &'static str)],
    generate_missing_id: bool,
}

fn d1_table_spec(table: &str) -> Result<D1TableSpec, String> {
    match table {
        "users" => Ok(D1TableSpec {
            source_name: "users",
            target_name: "users",
            target_columns: USERS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "tokens" => Ok(D1TableSpec {
            source_name: "tokens",
            target_name: "tokens",
            target_columns: TOKENS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "channels" => Ok(D1TableSpec {
            source_name: "channels",
            target_name: "channels",
            target_columns: CHANNELS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "abilities" => Ok(D1TableSpec {
            source_name: "abilities",
            target_name: "abilities",
            target_columns: ABILITIES_D1_COLUMNS,
            column_map: &[("group_name", "group")],
            generate_missing_id: true,
        }),
        "options" => Ok(D1TableSpec {
            source_name: "options",
            target_name: "options",
            target_columns: OPTIONS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: true,
        }),
        "logs" => Ok(D1TableSpec {
            source_name: "logs",
            target_name: "logs",
            target_columns: LOGS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "tasks" => Ok(D1TableSpec {
            source_name: "tasks",
            target_name: "tasks",
            target_columns: TASKS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "checkins" => Ok(D1TableSpec {
            source_name: "checkins",
            target_name: "checkins",
            target_columns: CHECKINS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "redemptions" => Ok(D1TableSpec {
            source_name: "redemptions",
            target_name: "redemptions",
            target_columns: REDEMPTIONS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "subscription_plans" => Ok(D1TableSpec {
            source_name: "subscription_plans",
            target_name: "subscription_plans",
            target_columns: SUBSCRIPTION_PLANS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "subscription_orders" => Ok(D1TableSpec {
            source_name: "subscription_orders",
            target_name: "subscription_orders",
            target_columns: SUBSCRIPTION_ORDERS_D1_COLUMNS,
            column_map: SUBSCRIPTION_ORDERS_D1_COLUMN_MAP,
            generate_missing_id: false,
        }),
        "user_subscriptions" => Ok(D1TableSpec {
            source_name: "user_subscriptions",
            target_name: "user_subscriptions",
            target_columns: USER_SUBSCRIPTIONS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "subscription_pre_consume_records" => Ok(D1TableSpec {
            source_name: "subscription_pre_consume_records",
            target_name: "subscription_pre_consume_records",
            target_columns: SUBSCRIPTION_PRE_CONSUME_RECORDS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: false,
        }),
        "vendors" => Ok(D1TableSpec {
            source_name: "vendors",
            target_name: "vendors",
            target_columns: VENDORS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: true,
        }),
        "models" => Ok(D1TableSpec {
            source_name: "models",
            target_name: "models",
            target_columns: MODELS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: true,
        }),
        "custom_oauth_providers" => Ok(D1TableSpec {
            source_name: "custom_oauth_providers",
            target_name: "custom_oauth_providers",
            target_columns: CUSTOM_OAUTH_PROVIDERS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: true,
        }),
        "user_oauth_bindings" => Ok(D1TableSpec {
            source_name: "user_oauth_bindings",
            target_name: "user_oauth_bindings",
            target_columns: USER_OAUTH_BINDINGS_D1_COLUMNS,
            column_map: &[],
            generate_missing_id: true,
        }),
        _ => Err(format!("unsupported D1 import table: {table}")),
    }
}

fn project_d1_row(
    spec: D1TableSpec,
    row: &Map<String, Value>,
    row_index: usize,
) -> Result<Vec<(String, Value)>, String> {
    let mut projected = Vec::new();
    for target_column in spec.target_columns {
        let source_column = spec
            .column_map
            .iter()
            .find_map(|(target, source)| (*target == *target_column).then_some(*source))
            .unwrap_or(target_column);

        if *target_column == "id" && spec.generate_missing_id && !row.contains_key(source_column) {
            projected.push((
                (*target_column).to_string(),
                Value::Number((row_index as u64 + 1).into()),
            ));
            continue;
        }

        if spec.target_name == "redemptions"
            && *target_column == "credited"
            && !row.contains_key(source_column)
        {
            let credited = matches!(row.get("status").and_then(Value::as_i64), Some(3));
            projected.push((
                (*target_column).to_string(),
                Value::Number(Number::from(if credited { 1 } else { 0 })),
            ));
            continue;
        }

        let Some(value) = row.get(source_column) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        projected.push(((*target_column).to_string(), value.clone()));
    }
    Ok(projected)
}

fn quote_ident(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn sql_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Number(value) => value.to_string(),
        Value::String(value) => sql_string(value),
        Value::Array(_) | Value::Object(_) => {
            let encoded = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
            sql_string(&encoded)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    const P0_SOURCE_FIXTURE: &str = include_str!("../tests/fixtures/p0_source.sql");
    const P0_TARGET_ROWS_FIXTURE: &str = include_str!("../tests/fixtures/p0_target_rows.sql");
    const D1_CORE_SCHEMA: &str = include_str!("../../../migrations/d1/0001_core.sql");
    const D1_SCHEMA_PARITY: &str = include_str!("../../../migrations/d1/0004_schema_parity.sql");

    #[test]
    fn sql_string_escapes_single_quotes() {
        assert_eq!(sql_string("sk-'quoted'"), "'sk-''quoted'''");
    }

    #[test]
    fn dev_seed_requires_upstream_key() {
        let err = DevSeedConfig::from_args_with_env(vec![], None).unwrap_err();
        assert!(err.contains("upstream-key"));
    }

    #[test]
    fn dev_seed_generates_expected_tables() {
        let config = DevSeedConfig::from_args_with_env(
            vec![
                "--upstream-key".to_string(),
                "sk-test".to_string(),
                "--token-key".to_string(),
                "ct-local".to_string(),
                "--model".to_string(),
                "gpt-test".to_string(),
            ],
            None,
        )
        .unwrap();
        let sql = config.to_sql();
        assert!(sql.contains("INSERT OR REPLACE INTO users"));
        assert!(sql.contains("INSERT OR REPLACE INTO tokens"));
        assert!(sql.contains("INSERT OR REPLACE INTO channels"));
        assert!(sql.contains("INSERT OR REPLACE INTO abilities"));
        assert!(sql.contains("'ct-local'"));
        assert!(sql.contains("'gpt-test'"));
        assert!(sql.contains("'sk-test'"));
    }

    #[test]
    fn dev_seed_parses_output_path() {
        let config = DevSeedConfig::from_args_with_env(
            vec![
                "--upstream-key".to_string(),
                "sk-test".to_string(),
                "--output".to_string(),
                ".wrangler/dev-seed.sql".to_string(),
            ],
            None,
        )
        .unwrap();
        assert_eq!(config.output.as_deref(), Some(".wrangler/dev-seed.sql"));
    }

    #[test]
    fn inspect_source_parses_repo_and_sqlite() {
        let temp = unique_temp_dir("inspect-source-parse");
        let sqlite = temp.join("one-api.db");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&sqlite, "").unwrap();

        let config = SourceInspectConfig::from_args(vec![
            "--repo".to_string(),
            temp.display().to_string(),
            "--sqlite".to_string(),
            sqlite.display().to_string(),
        ])
        .unwrap();

        assert_eq!(config.repo, temp);
        assert_eq!(config.sqlite.as_deref(), Some(sqlite.as_path()));
        fs::remove_dir_all(config.repo).unwrap();
    }

    #[test]
    fn source_marker_statuses_detect_expected_files() {
        let temp = unique_temp_dir("inspect-source-markers");
        fs::create_dir_all(temp.join("model")).unwrap();
        fs::write(temp.join("go.mod"), "module example.test/cinatoken").unwrap();
        fs::write(temp.join("model/main.go"), "").unwrap();

        let statuses = source_marker_statuses(&temp);
        let go_mod = statuses
            .iter()
            .find(|status| status.relative_path == "go.mod")
            .unwrap();
        let model_main = statuses
            .iter()
            .find(|status| status.relative_path == "model/main.go")
            .unwrap();
        let token_model = statuses
            .iter()
            .find(|status| status.relative_path == "model/token.go")
            .unwrap();

        assert!(go_mod.exists);
        assert!(model_main.exists);
        assert!(!token_model.exists);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn candidate_sqlite_paths_detect_common_files() {
        let temp = unique_temp_dir("inspect-source-sqlite");
        fs::create_dir_all(temp.join("data")).unwrap();
        let root_db = temp.join("one-api.db");
        let data_db = temp.join("data/cinatoken.sqlite3");
        fs::write(&root_db, "").unwrap();
        fs::write(&data_db, "").unwrap();

        let candidates = candidate_sqlite_paths(&temp);
        assert!(candidates.contains(&root_db));
        assert!(candidates.contains(&data_db));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn export_config_defaults_to_core_tables() {
        let temp = unique_temp_dir("export-defaults");
        let sqlite = temp.join("source.db");
        let output = temp.join("exports/source.json");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&sqlite, "").unwrap();

        let config = ExportConfig::from_args(vec![
            "--sqlite".to_string(),
            sqlite.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ])
        .unwrap();

        assert_eq!(config.sqlite, sqlite);
        assert_eq!(config.output, output);
        assert!(config.tables.contains(&"users".to_string()));
        assert!(config.tables.contains(&"channels".to_string()));
        assert!(!config.tables.contains(&"logs".to_string()));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn export_config_accepts_all_known_tables() {
        let temp = unique_temp_dir("export-all");
        let sqlite = temp.join("source.db");
        let output = temp.join("source.json");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&sqlite, "").unwrap();

        let config = ExportConfig::from_args(vec![
            "--sqlite".to_string(),
            sqlite.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
            "--all".to_string(),
        ])
        .unwrap();

        assert_eq!(config.tables.len(), SOURCE_TABLES.len());
        assert!(config.tables.contains(&"logs".to_string()));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn export_config_rejects_unknown_table() {
        let temp = unique_temp_dir("export-unknown-table");
        let sqlite = temp.join("source.db");
        let output = temp.join("source.json");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&sqlite, "").unwrap();

        let err = ExportConfig::from_args(vec![
            "--sqlite".to_string(),
            sqlite.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
            "--table".to_string(),
            "not_a_source_table".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("unknown export table"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn import_config_defaults_to_core_tables() {
        let temp = unique_temp_dir("import-defaults");
        let input = temp.join("core.cinatoken-export.json");
        let output = temp.join("core.d1.sql");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&input, "{}").unwrap();

        let config = ImportConfig::from_args(vec![
            "--input".to_string(),
            input.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
        ])
        .unwrap();

        assert_eq!(config.input, input);
        assert_eq!(config.output, output);
        assert_eq!(
            config.tables,
            vec![
                "users".to_string(),
                "tokens".to_string(),
                "channels".to_string(),
                "abilities".to_string(),
                "options".to_string()
            ]
        );
        assert!(!config.truncate);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn import_config_rejects_unsupported_table() {
        let temp = unique_temp_dir("import-unsupported-table");
        let input = temp.join("core.cinatoken-export.json");
        let output = temp.join("core.d1.sql");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&input, "{}").unwrap();

        let err = ImportConfig::from_args(vec![
            "--input".to_string(),
            input.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
            "--table".to_string(),
            // midjourneys is in the export list but intentionally not in the
            // D1 import list yet (async task tables land with G7).
            "midjourneys".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("unsupported D1 import table"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn import_config_accepts_vendors_and_models() {
        // vendors and models are now first-class D1 import tables so admin
        // CRUD (G5) can restore vendor/model metadata alongside the core
        // relay tables.
        let temp = unique_temp_dir("import-vendors-models");
        let input = temp.join("core.cinatoken-export.json");
        let output = temp.join("core.d1.sql");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&input, "{}").unwrap();

        let config = ImportConfig::from_args(vec![
            "--input".to_string(),
            input.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
            "--table".to_string(),
            "vendors".to_string(),
            "--table".to_string(),
            "models".to_string(),
        ])
        .unwrap();
        assert_eq!(config.tables, vec!["vendors", "models"]);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn import_config_accepts_checkins_and_redemptions() {
        let temp = unique_temp_dir("import-checkins-redemptions");
        let input = temp.join("core.cinatoken-export.json");
        let output = temp.join("core.d1.sql");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&input, "{}").unwrap();

        let config = ImportConfig::from_args(vec![
            "--input".to_string(),
            input.display().to_string(),
            "--output".to_string(),
            output.display().to_string(),
            "--table".to_string(),
            "checkins".to_string(),
            "--table".to_string(),
            "redemptions".to_string(),
        ])
        .unwrap();
        assert_eq!(config.tables, vec!["checkins", "redemptions"]);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn verify_config_requires_input_or_sql() {
        let err = VerifyConfig::from_args(vec![]).unwrap_err();
        assert!(err.contains("verify requires"));
    }

    #[test]
    fn verify_config_parses_input_sql_and_schema() {
        let temp = unique_temp_dir("verify-config");
        let input = temp.join("core.cinatoken-export.json");
        let sql = temp.join("core.d1.sql");
        let schema = temp.join("schema.sql");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&input, "{}").unwrap();
        fs::write(&sql, "").unwrap();
        fs::write(&schema, "").unwrap();

        let config = VerifyConfig::from_args(vec![
            "--input".to_string(),
            input.display().to_string(),
            "--sql".to_string(),
            sql.display().to_string(),
            "--schema".to_string(),
            schema.display().to_string(),
        ])
        .unwrap();

        assert_eq!(config.input.as_deref(), Some(input.as_path()));
        assert_eq!(config.sql.as_deref(), Some(sql.as_path()));
        assert_eq!(config.schema, schema);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reconcile_config_rejects_the_same_source_and_target() {
        let temp = unique_temp_dir("reconcile-same-database");
        let sqlite = temp.join("source.db");
        fs::create_dir_all(&temp).unwrap();
        fs::write(&sqlite, "").unwrap();

        let error = ReconcileConfig::from_args(vec![
            "--source".to_string(),
            sqlite.display().to_string(),
            "--target".to_string(),
            sqlite.display().to_string(),
        ])
        .unwrap_err();
        assert!(error.contains("must be different SQLite databases"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn render_import_sql_maps_ability_group_to_group_name() {
        let bundle = r#"{
          "format": "cinatoken-sqlite-export-v1",
          "tables": {
            "abilities": {
              "missing": false,
              "columns": ["group", "model", "channel_id", "enabled", "priority", "weight", "tag"],
              "rows": [
                {
                  "group": "default",
                  "model": "gpt-test",
                  "channel_id": 7,
                  "enabled": 1,
                  "priority": 2,
                  "weight": 100,
                  "tag": "primary"
                }
              ]
            }
          }
        }"#;
        let sql = render_d1_import_sql(bundle, &["abilities".to_string()], false).unwrap();

        assert!(sql.contains("\"group_name\""));
        assert!(sql.contains("'default'"));
        assert!(sql.contains("'gpt-test'"));
        assert!(sql.contains("\"tag\""));
        assert!(sql.contains("'primary'"));
        assert!(sql.contains("INSERT OR REPLACE INTO \"abilities\""));
    }

    #[test]
    fn export_orders_synthetic_id_tables_by_logical_key() {
        let temp = unique_temp_dir("export-logical-order");
        let source = temp.join("source.db");
        let output = temp.join("source.json");
        fs::create_dir_all(&temp).unwrap();
        execute_sqlite(&source, P0_SOURCE_FIXTURE);

        let summary = export_sqlite_json(&ExportConfig {
            sqlite: source,
            output: output.clone(),
            tables: D1_CORE_IMPORT_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect(),
        })
        .unwrap();
        assert!(summary.contains("options: 2 rows"));

        let bundle: Value = serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
        let options = bundle["tables"]["options"]["rows"].as_array().unwrap();
        assert_eq!(options[0]["key"], "ModelRatio");
        assert_eq!(options[1]["key"], "SystemName");
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reconcile_p0_manifest_is_deterministic_and_accepts_equivalent_rows() {
        let (temp, config) = p0_reconciliation_fixture("reconcile-pass");

        let first = reconcile_sqlite_databases(&config).unwrap();
        let second = reconcile_sqlite_databases(&config).unwrap();
        assert_eq!(first["source_manifest"], second["source_manifest"]);
        assert_eq!(
            first["target_manifest"]["tables"],
            second["target_manifest"]["tables"]
        );
        assert!(first["differences"].as_array().unwrap().is_empty());

        let manifest = first["source_manifest"].as_object().unwrap();
        assert_eq!(
            manifest["format"],
            "cinatoken-source-to-d1-reconciliation-v1"
        );
        assert_eq!(manifest["tables"]["users"]["count"], 1);
        assert_eq!(manifest["tables"]["options"]["count"], 2);
        assert_eq!(
            manifest["tables"]["users"]["pk_min"],
            serde_json::json!([["number", "1"]])
        );
        assert_eq!(
            manifest["tables"]["users"]["pk_max"],
            serde_json::json!([["number", "1"]])
        );
        assert_eq!(
            manifest["tables"]["users"]["sha256"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert_eq!(
            manifest["relationships"]["tokens.user_id->users.id"]["violations"],
            0
        );
        assert_eq!(
            manifest["relationships"]["abilities.channel_id->channels.id"]["violations"],
            0
        );
        let options_samples = manifest["tables"]["options"]["samples"].as_array().unwrap();
        assert_eq!(options_samples.len(), 2);

        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reconcile_command_writes_versioned_manifest_without_raw_secrets() {
        let (temp, config) = p0_reconciliation_fixture("reconcile-manifest-output");
        let output = temp.join("p0-manifest.json");

        reconcile_migration(vec![
            "--source".to_string(),
            config.source.display().to_string(),
            "--target".to_string(),
            config.target.display().to_string(),
            "--manifest-output".to_string(),
            output.display().to_string(),
            "--sample-size".to_string(),
            "10".to_string(),
        ])
        .unwrap();

        let manifest = fs::read_to_string(output).unwrap();
        assert!(manifest.contains("cinatoken-source-to-d1-reconciliation-v1"));
        assert!(manifest.contains("sha256-smallest-logical-pk-v1"));
        assert!(!manifest.contains("source-token-secret"));
        assert!(!manifest.contains("source-channel-secret"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reconcile_p0_fails_clearly_on_canonical_hash_drift() {
        let (temp, config) = p0_reconciliation_fixture("reconcile-hash-drift");
        execute_sqlite(
            &config.target,
            "UPDATE tokens SET remain_quota = remain_quota - 1 WHERE id = 10;",
        );

        let result = reconcile_sqlite_databases(&config).unwrap();
        let differences = result["differences"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .unwrap()
            .join("\n");
        assert!(differences.contains("table tokens: canonical SHA-256 differs"));
        assert!(differences.contains("table tokens: deterministic samples differ"));

        let error = reconcile_migration(vec![
            "--source".to_string(),
            config.source.display().to_string(),
            "--target".to_string(),
            config.target.display().to_string(),
        ])
        .unwrap_err();
        assert!(error.contains("P0 source-to-D1 reconciliation failed"));
        assert!(error.contains("table tokens: canonical SHA-256 differs"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reconcile_p0_keeps_json_shaped_credentials_byte_exact() {
        let (temp, config) = p0_reconciliation_fixture("reconcile-opaque-credentials");
        execute_sqlite(
            &config.source,
            r#"UPDATE tokens SET "key" = '{"a":1,"b":2}' WHERE id = 10;"#,
        );
        execute_sqlite(
            &config.target,
            r#"UPDATE tokens SET "key" = '{"b":2,"a":1}' WHERE id = 10;"#,
        );

        let result = reconcile_sqlite_databases(&config).unwrap();
        let differences = result["differences"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(differences.contains("table tokens: canonical SHA-256 differs"));

        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains(r#"{"a":1,"b":2}"#));
        assert!(!serialized.contains(r#"{"b":2,"a":1}"#));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn reconcile_p0_fails_on_broken_token_user_relationship() {
        let (temp, config) = p0_reconciliation_fixture("reconcile-relationship-drift");
        execute_sqlite(
            &config.target,
            "UPDATE tokens SET user_id = 999 WHERE id = 10;",
        );

        let result = reconcile_sqlite_databases(&config).unwrap();
        let differences = result["differences"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .unwrap()
            .join("\n");
        assert!(
            differences.contains("target relationship tokens.user_id->users.id: 1 violation(s)")
        );
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn render_import_sql_maps_subscription_order_compat_columns() {
        let bundle = r#"{
          "format": "cinatoken-sqlite-export-v1",
          "tables": {
            "subscription_orders": {
              "missing": false,
              "columns": [
                "id",
                "user_id",
                "plan_id",
                "money",
                "trade_no",
                "payment_method",
                "payment_provider",
                "status",
                "create_time",
                "complete_time",
                "provider_payload"
              ],
              "rows": [
                {
                  "id": 9,
                  "user_id": 1,
                  "plan_id": 3,
                  "money": 12.5,
                  "trade_no": "SUB123",
                  "payment_method": "balance",
                  "payment_provider": "balance",
                  "status": "success",
                  "create_time": 1710000000,
                  "complete_time": 1710000010,
                  "provider_payload": "charged_quota=6250000"
                }
              ]
            }
          }
        }"#;
        let sql =
            render_d1_import_sql(bundle, &["subscription_orders".to_string()], false).unwrap();

        assert!(sql.contains("\"order_no\""));
        assert!(sql.contains("\"trade_no\""));
        assert!(sql.contains("\"amount\""));
        assert!(sql.contains("\"money\""));
        assert!(sql.contains("'SUB123'"));
        assert!(sql.contains("'charged_quota=6250000'"));
    }

    #[test]
    fn render_import_sql_marks_used_redemptions_as_credited() {
        let bundle = r#"{
          "format": "cinatoken-sqlite-export-v1",
          "tables": {
            "redemptions": {
              "missing": false,
              "columns": [
                "id",
                "user_id",
                "key",
                "status",
                "name",
                "quota",
                "created_time",
                "redeemed_time",
                "used_user_id",
                "expired_time"
              ],
              "rows": [
                {
                  "id": 1,
                  "user_id": 1,
                  "key": "used-code",
                  "status": 3,
                  "name": "used",
                  "quota": 100,
                  "created_time": 1710000000,
                  "redeemed_time": 1710000010,
                  "used_user_id": 2,
                  "expired_time": 0
                },
                {
                  "id": 2,
                  "user_id": 1,
                  "key": "fresh-code",
                  "status": 1,
                  "name": "fresh",
                  "quota": 100,
                  "created_time": 1710000000,
                  "redeemed_time": 0,
                  "used_user_id": 0,
                  "expired_time": 0
                }
              ]
            }
          }
        }"#;
        let sql = render_d1_import_sql(bundle, &["redemptions".to_string()], false).unwrap();

        assert!(sql.contains("\"credited\""));
        assert!(sql.contains("'used-code'"));
        assert!(sql.contains("'fresh-code'"));
        assert!(sql.contains("'used', 100, 1710000000, 1710000010, 2, 0, 1)"));
        assert!(sql.contains("'fresh', 100, 1710000000, 0, 0, 0, 0)"));
    }

    #[test]
    fn verify_export_bundle_reports_rows_and_core_presence() {
        let bundle = r#"{
          "format": "cinatoken-sqlite-export-v1",
          "tables": {
            "users": {
              "missing": false,
              "columns": ["id", "username"],
              "rows": [{"id": 1, "username": "dev"}]
            },
            "tokens": {
              "missing": true,
              "columns": [],
              "rows": []
            }
          }
        }"#;

        let summary = verify_export_bundle(bundle).unwrap();
        assert!(summary.contains("users: 1 rows"));
        assert!(summary.contains("tokens: missing"));
        assert!(summary.contains("Core D1 tables present: 1/5"));
    }

    #[test]
    fn verify_export_bundle_rejects_non_object_rows() {
        let bundle = r#"{
          "format": "cinatoken-sqlite-export-v1",
          "tables": {
            "users": {
              "missing": false,
              "columns": ["id"],
              "rows": [1]
            }
          }
        }"#;

        let err = verify_export_bundle(bundle).unwrap_err();
        assert!(err.contains("row 1 is not an object"));
    }

    #[test]
    fn verify_d1_sql_executes_schema_and_sql() {
        let temp = unique_temp_dir("verify-d1-sql");
        let schema = temp.join("schema.sql");
        let sql = temp.join("import.sql");
        fs::create_dir_all(&temp).unwrap();
        fs::write(
            &schema,
            r#"
CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
CREATE TABLE tokens (id INTEGER PRIMARY KEY);
CREATE TABLE channels (id INTEGER PRIMARY KEY);
CREATE TABLE abilities (id INTEGER PRIMARY KEY);
CREATE TABLE options (id INTEGER PRIMARY KEY);
"#,
        )
        .unwrap();
        fs::write(
            &sql,
            r#"INSERT INTO users (id, username) VALUES (1, 'dev');"#,
        )
        .unwrap();

        let summary = verify_d1_sql_with_sqlite(&schema, &sql).unwrap();
        assert!(summary.contains("D1 SQL verified with SQLite"));
        assert!(summary.contains("users: 1"));
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn sql_literal_escapes_strings_and_json_objects() {
        assert_eq!(sql_literal(&Value::String("a'b".to_string())), "'a''b'");
        assert_eq!(sql_literal(&Value::Bool(true)), "1");
        assert_eq!(sql_literal(&Value::Bool(false)), "0");
        let object = serde_json::json!({"nested": "yes"});
        assert_eq!(sql_literal(&object), "'{\"nested\":\"yes\"}'");
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "cinatoken-migration-{name}-{}-{}",
            process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn p0_reconciliation_fixture(name: &str) -> (PathBuf, ReconcileConfig) {
        let temp = unique_temp_dir(name);
        let source = temp.join("source.db");
        let target = temp.join("target.db");
        fs::create_dir_all(&temp).unwrap();
        execute_sqlite(&source, P0_SOURCE_FIXTURE);
        execute_sqlite(
            &target,
            &format!("{D1_CORE_SCHEMA}\n{D1_SCHEMA_PARITY}\n{P0_TARGET_ROWS_FIXTURE}"),
        );
        let config = ReconcileConfig {
            source,
            target,
            manifest_output: None,
            sample_size: 1_000,
        };
        (temp, config)
    }

    fn execute_sqlite(path: &Path, sql: &str) {
        let mut child = Command::new("python")
            .arg("-c")
            .arg(
                "import sqlite3, sys; connection = sqlite3.connect(sys.argv[1]); \
                 connection.executescript(sys.stdin.read()); connection.close()",
            )
            .arg(path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(sql.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "SQLite fixture failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
