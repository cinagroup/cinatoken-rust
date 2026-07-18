# Go/VPS Production Cutover Evidence Contract

Date: 2026-07-19

Status: offline, read-only review gate. This contract never authorizes a
production cutover, a Go/VPS shutdown, traffic movement, a deployment, or any
other mutation.

## Purpose

Quiet HTTP counters are not enough to retire Go/VPS. The pinned Go runtime can
retain request-local financial state, refund work, deferred batch maps, long
lived SSE/WebSocket activity, and configuration-owned schedulers. A hot Go
rollback target is also unsafe after Cloudflare accepts writes unless those
writes are present in Go with zero reverse-sync lag and conflict.

This contract accepts only one immutable, redacted evidence bundle for Go HEAD:

`73652508abc5cb09214dde02d51d69d1d1ccc703`

It can return only:

- `not-proven`; or
- `eligible-for-production-cutover-review`.

`productionCutoverAuthorized` is always `false`. A passing verifier result is
input to an independent release review, not approval and not an executable
switch.

## Implementation

The implementation is limited to:

- `tools/go_vps_cutover_evidence_contract.mjs`;
- `tools/verify_go_vps_cutover_evidence.mjs`;
- `tests/go-vps-cutover-evidence.test.mjs`; and
- this document.

Inspect the contract without evidence:

```powershell
bun run plan:go-vps-cutover:evidence
```

Verify a pre-generated bundle:

```powershell
bun run verify:go-vps-cutover:evidence -- `
  --manifest C:\secure-evidence\go-vps-cutover\manifest.json `
  --json
```

Run the focused local suite:

```powershell
bun run check:go-vps-cutover:evidence
```

The credential-free focused suite is also part of the repository-wide
`bun run check` gate.

## Read-Only Boundary

The CLI reads only a canonical manifest and the pre-generated redacted JSON
files referenced by that manifest. It does not:

- import or invoke a source-inspection command;
- spawn a process or execute shell, Wrangler, SQL, or a database client;
- call a network API;
- read `process.env`, credential files, secret values, private keys, or raw
  application configuration;
- write, normalize, collect, or repair evidence;
- print process IDs, scheduler IDs, paths from evidence facts, log lines,
  request/response bodies, or line payloads; or
- mutate traffic, Cloudflare, Go/VPS, SQL, LOG_DB, Redis, or rollback state.

Authenticated operational collectors are outside this verifier. They must emit
the exact redacted JSON schema before invocation. Collector identity is bound
by `collectorId`, `collectorVersion`, and `sourceArtifactSha256`; none is a
credential or a secret value.

## Bundle Layout

The bundle has one fixed layout:

```text
manifest.json
evidence/
  candidate-topology.json
  ingress-drain.json
  process-state-drain.json
  persistence-stability.json
  scheduler-ownership.json
  bidirectional-sync.json
  pending-work.json
  rollback-bundle.json
```

Every path is exactly `evidence/<kind>.json`. Absolute paths, backslashes,
alternate names, traversal, symbolic links, linked directories, hard-linked
files, non-regular files, and real paths outside the bundle are rejected.

## Canonical And File Rules

Every JSON file must be UTF-8 canonical JSON followed by exactly one newline:

- object keys are sorted recursively;
- arrays retain their contract order;
- every number is a safe integer; floats, unsafe integers, and negative zero
  encodings are rejected;
- fields are exact at every node; missing and unknown fields are rejected;
- duplicate JSON members, invalid UTF-8, extra whitespace, and trailing lines
  are rejected;
- strings are bounded, single-line, and NUL-free; and
- JSON depth, node count, individual file size, and total evidence size are
  bounded.

The manifest is limited to 1 MiB. Each evidence file is limited to 512 KiB and
the evidence total is limited to 4 MiB. Each file is opened once and checked by
file identity, link count, size, mtime, and ctime before and after the read.
The manifest reference must match the observed byte count and SHA-256 digest.

Field names associated with secrets, credentials, passwords, private keys,
authorization, API/access/refresh tokens, payloads, bodies, headers, cookies,
SQL text, or log lines are rejected before facts are evaluated. Strict schemas
then reject every other unrecognized field. Common bearer, API-key, JWT, PEM,
GitHub/GitLab token, and AWS access-key value shapes are rejected even when
placed in an otherwise allowed string field; the rejected value is never
included in the error.

## Manifest Identity

The manifest contract is:

`cinatoken-go-vps-production-cutover-manifest-v1`

The top-level object contains exactly:

- `schemaVersion` equal to `1`;
- `contract`;
- `subject`; and
- `subjectDigestSha256`.

The subject contains exactly the candidate, candidate digest, cohort, cohort
digest, requested decision, generated/expiry times, and eight evidence
references. `subjectDigestSha256` is SHA-256 over canonical subject JSON.

### Candidate

The candidate fixes:

- repository `cinagroup/cinatoken-rust` and its 40-hex-character commit identity;
- Go repository `cinagroup/cinatoken` and the pinned Go HEAD;
- Go artifact and deployment digests;
- Cloudflare deployment digest; and
- SQL, LOG_DB, Redis, and load-balancer identity digests.

`candidateDigestSha256` is SHA-256 over canonical candidate JSON. The topology
evidence must independently read back every candidate field.

### Cohort

The cohort is exactly `full-production`, source authority `go-vps`, target
authority `cloudflare`, and environment `production`. It binds:

- a cutover ID and freeze timestamp;
- complete sorted unique Go process and scheduler inventories; and
- traffic-scope and data-scope digests.

`cohortDigestSha256` is SHA-256 over canonical cohort JSON. Every evidence file
binds both candidate and cohort digests, so files from another deployment,
scope, process inventory, or scheduler inventory cannot be mixed into a packet.

### Evidence References

All eight kinds are required exactly once and in contract order. Each reference
contains exactly `kind`, `path`, `bytes`, `sha256`, `capturedAt`, and
`expiresAt`. The referenced envelope must repeat the kind, capture/expiry time,
candidate digest, and cohort digest exactly.

## Evidence Status

Every envelope and status-bearing fact uses only:

- `pass`;
- `fail`;
- `unknown`; or
- `not-applicable`.

Only `pass` can satisfy a required production fact. `fail`, `unknown`, and
`not-applicable` are valid report values but always produce `not-proven`.
Missing evidence or nodes, an unknown status spelling, an invalid schema, or an
integrity failure rejects the packet. A declared `pass` never overrides a
non-zero count, digest difference, short interval, duplicate owner, or other
fact-level blocker.

## Required Evidence

### Candidate Topology

`candidate-topology` must prove the pinned Go HEAD and exact artifact,
deployment, database, Redis, load-balancer, and Cloudflare identities. Every
cohort process is present once, reports the same Go artifact, has a passing
observation, and is classified as `master` or `replica`. There is exactly one
master/authority owner, zero unknown processes, and the scheduler inventory is
identical to the cohort.

### Ingress Drain

`ingress-drain` records the last accepted operation, drain start, and observation
end. The observation is at least 60 seconds. LB and host connection counts are
zero. HTTP, SSE, WebSocket, and task-submit each independently report:

- status `pass`;
- zero accepted after drain;
- zero active; and
- zero in flight.

All four protocols are mandatory. An application HTTP counter cannot stand in
for SSE, WebSocket, task-submit, LB, or host evidence.

### Per-Process State Drain

`process-state-drain` contains one row for every cohort process. Each row is
captured after persistence is stable and directly proves zero:

- `BillingSession` instances;
- refund jobs; and
- user, token, channel, usage, and request batch maps.

Every process, financial observation, and map observation must be `pass`.
Aggregate counts cannot replace per-process rows.

### Persistence Stability

`persistence-stability` binds exact SQL and LOG_DB identities and proves:

- at least two successful, ordered, non-overlapping flush cycles;
- two complete configured batch intervals after the final accepted request;
- one successful complete export interval after the final accepted request;
- zero batch, export, token-adjustment, settlement, refund, and log-write
  errors; and
- two passing SQL snapshots and two passing LOG_DB snapshots after the final
  flush/export cycle.

The two snapshots for each store are at least the configured stability interval
apart. That interval is no shorter than either the batch or export interval.
Row count, high-watermark digest, normalized snapshot digest, and canonical
chunk-set digest must remain identical for each store.

### Scheduler Ownership

`scheduler-ownership` binds the cohort scheduler list. Expected, discovered,
and row counts equal the cohort count, inventory status is `pass`, and unknown
scheduler count is zero. Every scheduler appears once and has exactly one owner
with a digest of the observed owner set. Zero owners, duplicate owners,
duplicate rows, omissions, and extra/unknown schedulers block review.

### Bidirectional Sync And Reconciliation

`bidirectional-sync` requires both `goToCloudflare` and `cloudflareToGo` after
persistence stability. Each direction has:

- zero record and time lag;
- zero conflicts and unresolved writes;
- accepted-write count equal to applied-write count; and
- equal source/target write-set and high-watermark digests.

Quota, request, channel, subscription, task, order, provider, and audit domains
also require passing status, zero unexplained differences, and equal canonical
source/target digests. Forward-only synchronization cannot pass this contract.

### Pending Tasks And Orders

`pending-work` contains separate task and order facts captured after ingress
drain. Each must be one of:

- `empty`: source pending, handoff, target readback, and unaccounted counts are
  all zero, with no handoff digest; or
- `durable-handoff`: source pending is positive, handoff and target readback
  counts equal it, unaccounted count is zero, and a handoff digest is present.

`not-applicable` is not a substitute for proving empty or durable handoff.

### Rollback Bundle

`rollback-bundle` requires a measured passing restore with Go readiness,
session continuity, and inclusion of every accepted write. Measured RTO/RPO
must not exceed their targets. The following digest/size/readback records are
required exactly once and in order:

1. Cloudflare disable plan;
2. pinned Go runtime;
3. redacted Go configuration;
4. SQL snapshot;
5. LOG_DB snapshot;
6. Redis snapshot;
7. routing plan;
8. scheduler-owner plan;
9. reverse-sync checkpoint;
10. rollback runbook; and
11. evidence index.

Every component is `pass`, has non-zero bytes, a unique SHA-256 digest, and a
verification timestamp. The Go runtime component digest must equal the frozen
candidate artifact digest. The verifier intentionally does not read these
non-JSON rollback artifacts; their independently collected redacted inventory
is the evidence input.

## Time Rules

All timestamps are canonical UTC ISO strings with milliseconds. The verifier
allows at most 60 seconds of clock skew. The manifest review window is at most
30 minutes. Cohort freeze and evidence captures are no more than six hours old.

Evidence must be captured:

- at or after cohort freeze;
- no later than manifest generation;
- no later than the evidence envelope capture for nested events; and
- with an expiry that covers the complete manifest review window.

The contract also enforces the operational sequence: flush/export follows the
last accepted request, snapshots follow the final cycles, per-process drain and
bidirectional sync follow stable persistence, scheduler ownership follows drain
start, and pending-work disposition follows ingress drain.

## Decision And Exit Behavior

For a structurally valid packet, the verifier returns a static blocker code for
each declared non-pass status or failed fact. It does not echo fact values or
identifiers. Any blocker yields `not-proven` and a non-zero CLI exit code.

Only a packet with all eight envelopes declared `pass` and no fact blocker
returns `eligible-for-production-cutover-review`. It still returns:

```json
{"productionCutoverAuthorized":false}
```

Schema, canonicalization, redaction, path, file-stability, digest, or time
integrity errors reject verification and the CLI reports `not-proven` with a
non-zero exit code. There is no mode that flips traffic or changes the hard
authorization boundary.

## Local Test Boundary

The focused suite builds only temporary canonical JSON fixtures. It covers a
complete success packet plus path escape, symbolic links, byte/digest drift,
missing references/nodes, non-zero protocol state, unknown process finance,
insufficient flushes, SQL/LOG_DB drift, duplicate scheduler owners, forward
lag, reverse conflicts, incomplete pending-work handoff, incomplete rollback,
payload/secret fields, stale/future timestamps, noncanonical JSON, and unsafe
integers.

The success fixture is not production evidence. No remote state, credential,
traffic, SQL row, LOG_DB row, scheduler, task, order, or rollback target is read
or changed by the suite.
