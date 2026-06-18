# Source Inspection

The migration CLI can inspect a legacy Go source checkout before any data is
exported or imported. This command is read-only: it checks for expected source
files, looks for common local SQLite database names, and optionally counts rows
inside a supplied SQLite database.

## Static Repository Scan

From `Z:\cinatoken-rust`:

```powershell
bun run inspect:source -- --repo Z:\cinatoken
```

The scan currently checks for:

- `go.mod`
- `model/main.go`
- `model/user.go`
- `model/token.go`
- `model/channel.go`
- `model/ability.go`
- `relay/channel`
- `pkg/billingexpr/expr.md`
- `web/default/package.json`

It also reports database hints from these environment variables:

- `SQL_DSN`
- `LOG_SQL_DSN`
- `SQLITE_PATH`
- `SQLITE_DSN`

## SQLite Row Counts

If the legacy deployment uses SQLite, pass the database path explicitly:

```powershell
bun run inspect:source -- --repo Z:\cinatoken --sqlite Z:\path\to\one-api.db
```

The tool counts the migration-relevant source tables and marks missing tables
without failing the run. This gives a quick estimate of import scope before the
future `export` and `import` commands are used.

## Current Local Result

The local `Z:\cinatoken` checkout has all expected source markers. No SQLite
database was found in common repository locations, and no database DSN
environment variable was set in the current shell.

Once a SQLite database path is available, use `docs/data-export.md` to create a
JSON export bundle.
