# Data Export

The migration CLI can export a legacy SQLite database to a JSON bundle. This is
the first durable handoff format before D1 import and validation are
implemented.

Export files contain sensitive data, including user records, token keys, and
channel upstream keys. Keep them outside source control. The repository ignores
`exports/` and `*.cinatoken-export.json` by default.

## Core Export

```powershell
bun run export:sqlite -- --sqlite Z:\path\to\one-api.db --output exports\core.cinatoken-export.json
```

Validate the bundle structure and row counts:

```powershell
bun run verify:migration -- --input exports\core.cinatoken-export.json
```

By default the CLI exports the core configuration tables needed by the current
Worker MVP:

- `users`
- `tokens`
- `channels`
- `abilities`
- `options`
- `models`
- `vendors`
- `prefill_groups`
- `setups`

## Selected Tables

Use repeatable `--table` flags to export a precise subset:

```powershell
bun run export:sqlite -- `
  --sqlite Z:\path\to\one-api.db `
  --output exports\auth-and-relay.cinatoken-export.json `
  --table users `
  --table tokens `
  --table channels `
  --table abilities
```

Only known migration tables are accepted. Unknown names fail fast so typos do
not silently produce incomplete bundles.

## Full Export

Use `--all` when you intentionally want every known source table, including
logs and operational history:

```powershell
bun run export:sqlite -- --sqlite Z:\path\to\one-api.db --output exports\full.cinatoken-export.json --all
```

Large `logs`, `quota_data`, or task tables can make this file very large.
Prefer the core export until D1 import and post-import verification are ready.

## Generate D1 SQL

Convert a JSON export bundle into reviewable D1 SQL:

```powershell
bun run import:d1-sql -- `
  --input exports\core.cinatoken-export.json `
  --output exports\core.d1.sql
```

Validate the generated SQL against the D1 schema with local SQLite:

```powershell
bun run verify:migration -- `
  --input exports\core.cinatoken-export.json `
  --sql exports\core.d1.sql
```

By default this imports the Worker MVP tables:

- `users`
- `tokens`
- `channels`
- `abilities`
- `options`

Use `--table` to select supported D1 tables explicitly:

```powershell
bun run import:d1-sql -- `
  --input exports\core.cinatoken-export.json `
  --output exports\relay-only.d1.sql `
  --table channels `
  --table abilities
```

Use `--truncate` only for a fresh target database or a deliberate overwrite:

```powershell
bun run import:d1-sql -- `
  --input exports\core.cinatoken-export.json `
  --output exports\core-reset.d1.sql `
  --truncate
```

Apply the generated SQL after review:

```powershell
wrangler d1 execute cinatoken-rust-db --local --file exports\core.d1.sql
```

The `abilities` source table uses the legacy `group` column. The converter maps
it to the D1 `group_name` column used by the Worker channel selector.
