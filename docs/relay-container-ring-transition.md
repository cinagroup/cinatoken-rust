# Relay Container Adjacent Ring Transition

Date: 2026-07-23

Status: local runtime contract implemented; remote Cloudflare evidence not yet
captured; production remains **NO-GO**.

## Purpose

This contract removes the mandatory stop-the-world drain from an expansion of
the native Container shard ring. It supports exactly one adjacent, expand-only
transition:

```text
previous: generation G,   shard count N
current:  generation G+1, shard count M, where M > N
```

The routing secret and Jump Consistent Hash contract stay unchanged. Secret
rotation, protocol changes, image changes not included in the frozen candidate,
and ring expansion must not share one production change.

Canonical instance names remain `cinatoken-relay-shard-v1-XXXX`. A shard index
shared by both rings therefore resolves through `getByName()` to the same
Durable Object and Container. DO SQLite stores the complete ring fence on each
operation while the singleton shard state records the highest activated ring.

## Configuration Contract

| Variable | Disabled value | Transition value |
| --- | --- | --- |
| `CONTAINER_RING_GENERATION` | current positive generation | `G+1` |
| `CONTAINER_SHARD_COUNT` | current count | `M` |
| `CONTAINER_PREVIOUS_RING_GENERATION` | `0` | `G` |
| `CONTAINER_PREVIOUS_SHARD_COUNT` | `0` | `N` |
| `CONTAINER_PREVIOUS_RING_ADMISSION_STARTED_AT` | `0` | absolute Unix seconds |
| `CONTAINER_PREVIOUS_RING_ADMISSION_UNTIL` | `0` | absolute Unix seconds |

The four previous-ring values must be all zero or all valid. A valid transition
requires adjacent generations, strict expansion, a positive ordered time
window, and a window no longer than 900 seconds. Partial, non-decimal,
non-adjacent, scale-down, same-size, overlong, or otherwise malformed settings
make operation and readiness verification fail closed.

Every tracked local, staging, and production config keeps all four values at
`0`. The ordinary deploy preflight also requires zero values. A future live
transition must use a separately reviewed transition manifest and must never
turn a committed default into a standing compatibility window.

## Admission State Machine

| Request ring | Window state | Result before provider I/O |
| --- | --- | --- |
| current | before, during, or after | normal current admission |
| previous | open | normal previous admission |
| previous | not open or expired, exact existing operation/dispatch | existing outcome replay |
| previous | not open or expired, new operation | `409 previous_ring_admission_closed` |
| any unrelated ring | any | `409 stale_shard_fence` |
| any ring with invalid transition config | any | `503 ring_transition_misconfigured` |

The replay-only decision is made transactionally in DO SQLite. A replay-only
request skips the global D1 admission read and cannot reach Container or
provider I/O. Status v1-v4 and terminal ACK v1-v3 remain historical-fence
readers: they route by canonical instance name and require an exact persisted
operation fence, so drain and reconciliation continue after the admission
window and after the transition config is removed.

The DO permits previous and current operations to overlap only when the exact
configured adjacent pair is presented. Current readiness may advance the
singleton shard state while previous operations are active. Without this exact
transition, the original `ring_generation_in_flight` drained fence remains.

## Production Expansion Runbook

1. **Security and candidate freeze.** Prove the exposed credential revoked;
   freeze edge and Controller versions, runtime image/build/provenance, D1/KV/R2
   identities, routing secret version, old and new ring, provider watermark,
   Go/VPS fallback route, dashboards, abort owner, and rollback packet.
2. **Capacity and activation evidence.** Provision `M` Controller capacity and
   complete all-shard current-ring readiness/activation evidence in isolated
   staging against the exact candidate. Do not use customer traffic or a paid
   provider call for activation.
3. **Transition manifest.** Choose an absolute window no longer than 900
   seconds, with operational margin before the start and at least a five-second
   edge switch safety margin before the cutoff. Bind the four transition values
   and both ring identities into the signed change record.
4. **Controller first.** Deploy the approved Controller with current `G+1/M`,
   previous `G/N`, the open bounded window, and `max_instances >= M`. Confirm
   signed status reports `ring_transition_configured=true`,
   `ring_transition_valid=true`, and the exact previous ring/window. Old edge
   traffic now enters as `previous_admit`.
5. **Edge second.** Deploy the edge with `G+1/M` and the unchanged routing
   secret. Require signed Controller status before admitting the canary. Stop
   rollout if any edge still emits previous-ring new operations inside the
   five-second cutoff margin.
6. **Canary and expansion.** Prove old/new overlap on shared shard indices,
   movement only to newly appended shards, capacity bounds, cold/warm lifecycle,
   one provider attempt, exact D1/DO/R2/billing conservation, and no cross-ring
   operation collision. Expand the cohort only while all evidence remains tied
   to the frozen candidate.
7. **Cutoff.** Let the immutable deadline close old-ring admission. Prove a new
   previous-ring operation returns `previous_ring_admission_closed`, while an
   exact prior request replays and status/terminal ACK still converge.
8. **Drain and close.** Keep the dual-ring Controller until every previous-ring
   operation, recovery intent, provider attempt, result artifact, terminal ACK,
   billing event, and audit record is terminal or explicitly quarantined. Then
   deploy the same current ring with all four previous-ring values reset to
   `0`; do not rotate the routing or authority secret in this cleanup deploy.

## Rollback

Before any current-ring readiness or operation changes persistent shard state,
the candidate may be withdrawn only with evidence that every DO remains at the
previous generation. After any shard advances, generation rollback is
forbidden.

The universal rollback is:

1. stop new Rust/Container admission and route new customer traffic to the hot
   Go/VPS authority;
2. retain the exact dual-generation Controller, storage resources, Queue/D1
   reconciliation owners, and transition metadata for drain;
3. do not resend ambiguous provider operations, refund an unresolved reserve,
   delete migrations, or deploy an old Controller against forward-only DO
   state;
4. repair forward at `G+1/M`, repeat isolated evidence, and resume only through
   a new signed candidate.

Rolling the edge back to `G/N` is not a durable rollback after the old-ring
admission cutoff. It would create new requests that the Controller correctly
rejects. Go/VPS is the traffic rollback owner; the Rust Controller remains the
drain owner.

## Required Remote Evidence

- signed Controller status before, during, and after the window;
- every current shard ready, exact Controller version and runtime build;
- real-tenant routing distribution and Jump Hash movement bounds;
- old/new shared-DO overlap with restart, eviction, sleep, timeout, and capacity
  faults;
- cutoff new-claim rejection plus exact replay, status, recovery, and ACK proof;
- D1/DO/R2/provider/billing/audit conservation with no duplicate side effect;
- load, latency, CPU, memory, Container start rate, cost, alert, and soak data;
- Go/VPS traffic rollback and forward-only recovery rehearsal;
- reviewed P5, security, privacy, finance, SRE, migration, and rollback packets.

Local tests establish parser, bounded-window, adjacent-ring, replay-only, and
DO overlap behavior. They do not establish Cloudflare propagation timing,
Container lifecycle, provider behavior, billing correctness under remote
faults, or production eligibility.
