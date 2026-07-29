# Operation 6-13 Shard Readiness Receipts

## Status

The local Authority and Controller implementation for placement operations
6-13 is complete and default-off. It proves candidate activation readiness,
not production traffic readiness. Go/VPS remains authoritative, operation 14
remains an independent required disable/recovery path, and production remains
**NO-GO**.

No remote Cloudflare state, credential, migration, deployment, Container,
route, DNS, traffic, or billing state was read or changed by this checkpoint.

## Purpose

Operations 6-13 map ordinal to shard without caller choice:

```text
operation ordinal 6..13
  -> shard index ordinal - 6
  -> cinatoken-relay-shard-v1-0000..0007
  -> one candidate readiness wake at most
  -> immutable Authority attempt receipt
  -> immutable healthy or failure terminal receipt
```

A successful operation proves all of the following for the frozen candidate:

- the Container is healthy;
- the runtime process is ready;
- runtime execution remains disabled;
- Controller execution remains disabled;
- the result code is exactly `process_ready_execution_disabled`;
- Controller service, Controller Worker version, runtime build, ring,
  campaign, operation, shard, and Authority version identities match; and
- the durable readiness journal is complete and digest-bound.

This is intentionally narrower than customer-serving readiness. It does not
authorize provider calls, billing writes, routing changes, or production
traffic.

## Private Routes And Roles

Authority routes:

```text
POST /internal/v1/shard-placement/execution-claims/{authorization_id_sha256}/probe-shard-readiness
POST /internal/v1/shard-placement/execution-claims/{authorization_id_sha256}/recover-shard-readiness
```

The fresh route uses the existing Authority `send` HMAC role. The recovery
route uses the existing Authority `recovery` HMAC role.

Authority calls the Controller only through the private
`CONTAINER_CONTROLLER` Service Binding:

```text
POST /internal/v1/shard-placement/readiness/probe
POST /internal/v1/shard-placement/readiness/readback
```

The Controller protocol uses a dedicated header, HMAC domain, issuer, and
audience. Probe and readback have independent credentials:

- `readiness_probe` may claim the exact activation campaign and request one
  wake;
- `readiness_readback` may only load an existing campaign claim and replay an
  existing Durable Object journal.

Readback cannot create a campaign claim, initialize a missing probe, or grant
another wake.

## Default-Off Gates

Authority requires four independent gates:

```text
SHARD_PLACEMENT_AUTHORITY_READINESS_PROBE_ENABLED
SHARD_PLACEMENT_AUTHORITY_READINESS_READBACK_ENABLED
SHARD_PLACEMENT_AUTHORITY_READINESS_ATTEMPT_WRITE_ENABLED
SHARD_PLACEMENT_AUTHORITY_READINESS_TERMINAL_WRITE_ENABLED
```

All are `false` in tracked local and staging configuration. The Authority has
no tracked production configuration. HMAC secrets are remote-only and are not
present in tracked Wrangler files.

Controller execution and general readiness/wake gates remain false in every
tracked Controller environment. This protocol does not bypass those disabled
execution semantics.

## Authority D1 State Machine

Migration `0008_operation_readiness_receipts.sql` adds two append-only
sidecars:

- `shard_placement_authority_operation_readiness_attempts`;
- `shard_placement_authority_operation_readiness_terminals`.

For operation ordinal `n` in `6..13`, the receipt ledger is fixed:

| State | Ledger version or sequence |
| --- | --- |
| Before operation | `2*n - 7` |
| Start receipt | `2*n - 6` |
| Terminal receipt | `2*n - 5` |

The attempt sidecar and generic `operation_started` receipt are written in one
D1 batch. The terminal sidecar and generic `operation_terminal` receipt are
also written in one D1 batch. Repository readback requires both rows and the
projected claim state to match exactly before reporting success or replay.

Database triggers independently enforce:

- ordinal 6-13 and shard 0-7 correspondence;
- the deterministic instance name;
- frozen claim, lease, schedule, ledger, campaign, ring, runtime, operation-5
  terminal, Controller service, and enabled Controller version identities;
- one wake attempt, zero retry allowance, and no resend after missing
  readback;
- append-only attempt and terminal evidence;
- exact healthy terminal semantics; and
- failure projection to `disable_required` while preserving operation 14.

D1 `unixepoch()` is the authority for source, deadline, and terminal checks.
Worker wall-clock time is not used to decide whether terminal evidence may be
committed.

## Wake And Recovery Rules

| Condition | Authority behavior | Controller behavior |
| --- | --- | --- |
| No attempt exists | Persist attempt and start receipt before I/O | Probe role may claim and wake once |
| Attempt create exact-replays | Switch to readback only | Existing-only claim and journal replay |
| Probe returns healthy disabled evidence | Persist `exact_success` | Return bounded no-store evidence |
| Probe transport outcome is unknown | Leave operation in flight; return `readback_only` | No automatic transport retry |
| Existing attempt is called again | Never probe again | Readback role and replay-only journal |
| Readback proves healthy evidence | Persist `ambiguous_recovered` | Return exact completed journal |
| Explicit unhealthy evidence | Persist `rejected` | No success eligibility |
| Readback remains unknown | Persist `unresolved` | Manual disable path required |
| Terminal already exists | Return exact persisted terminal | Zero Controller call |

A readback call receives a new bounded call deadline derived from D1 time,
lease, recovery deadline, and permit expiry. The immutable wake deadline stays
in the attempt sidecar and readiness journal. This permits late evidence
readback without rewriting or resending the original wake.

## Controller Acceptance

The Controller response is bounded to 16 KiB, must be JSON with `no-store`,
must not redirect or use content encoding, and must bind the same-request
`CF_VERSION_METADATA.id`.

Healthy eligibility requires:

```text
container_state = healthy
process_ready = true
execution_ready = false
runtime_execution_enabled = false
controller_execution_enabled = false
result_code = process_ready_execution_disabled
```

Any version, runtime, campaign, ring, action-gate, journal, result digest, or
disabled-execution contradiction fails closed.

The Authority performs exactly one Service Binding fetch for each probe or
readback call. It uses a 12-second timeout, streaming bounded response read,
and no automatic retry.

## Promotion Requirements

Local implementation is not a production promotion signal. Isolated staging
must still prove:

1. remote Authority migration 0008 schema and normalized trigger SQL;
2. the private Authority-to-Controller Service Binding resolves only to the
   frozen staging Controller service;
3. probe and readback credentials have least privilege, current/previous
   rotation, and retired-key denial evidence;
4. exactly one wake across concurrent calls, response loss, timeout, Worker
   rollout, D1 commit-response loss, and caller retry;
5. readback never creates a claim or wake when evidence is missing;
6. ordered shard 0-7 success against one frozen ring, campaign, Controller
   version, and runtime build;
7. every unhealthy or unresolved case reaches the independent operation-14
   disable proof;
8. Go/VPS shadow comparison, reverse sync, rollback, drain, and recovery
   rehearsal;
9. customer traffic, billing conservation, load, cost, alert, and SLO
   evidence; and
10. security, operations, release, rollback, and SRE approval.

Until all of those are independently captured and reviewed, all readiness
gates stay false, Go/VPS remains authoritative, and production remains
**NO-GO**.

## Local Verification

The focused and aggregate local gates are:

```text
bun run check:shard-placement-authority
bun run check:container-controller
bun test --path-ignore-patterns="target/**" \
  services/container-controller/tests/shard_placement_readiness.test.ts \
  tests/container-controller-config.test.mjs
```

They cover strict cross-service request/response contracts, role-separated
HMAC, existing-only readback, one-wake orchestration, D1-authoritative time,
healthy and failure terminalization, exact replay, complete migration
installation, generated types, Wrangler dry-run, and Workerd runtime
compatibility.
