# Operation 14 Controller Disable and Recovery

## Status

This document defines the local production contract for execution operation
14. It does not authorize a Cloudflare deployment, remote migration, secret
change, traffic shift, DNS change, billing change, or Go/VPS rollback.

Operation 14 proves that the isolated Container Controller has returned to the
frozen disabled baseline deployment. It does not prove that accepted work has
drained, reverse synchronization is complete, financial state is reconciled,
or Go/VPS is ready to receive traffic.

Production remains **NO-GO** until the remote evidence and independent cutover
gates in this document are satisfied.

The local implementation is complete for the private Authority routes,
Deployment Gateway disable namespace, D1 append-only sidecars, Controller
read-only attestation, default-off configuration, and cross-service
orchestration. No remote Cloudflare state was read or changed.

## Source design constraints

The source systems establish four constraints that are retained in the Rust
architecture:

1. cinaVibeSDK gives stable Durable Object identities their own local state and
   treats Containers as replaceable execution resources. Container shutdown is
   best-effort lifecycle work, not durable disabled-state evidence.
2. cinaVibeSDK separates Worker, Durable Object, Container, D1, KV, and R2
   responsibilities. A local DO or Container observation cannot replace the
   global business and financial authority in D1.
3. cinatoken-go persists disabled identities and distinguishes automatic from
   manual disable. Recovery cannot silently overwrite a stronger disable
   decision.
4. cinatoken-go makes settlement and refund mutually exclusive and gives task
   terminal transitions a single CAS winner. Controller rollback must never
   imply provider resend, automatic refund, repricing, or terminal ownership.

The resulting Cloudflare authority map is:

| Layer | Authority |
|---|---|
| Edge Worker | authentication, limits, frozen routing identity, billing reservation |
| Shard DO | shard fence, lease, at-most-once journal, capacity and lifecycle |
| Rust Container | execute the frozen operation and return bounded evidence |
| D1/R2/KV | D1 business/financial/audit truth, R2 immutable large evidence, KV versioned cache only |

Controller and Deployment Gateway Workers are private control-plane services
within the second layer. They are not new business authorities.

## Frozen operation

Execution schedule ordinal 14 is always:

```text
kind        = disable_controller_deployment
shard_index = null
```

The disabled target is the exact `controller_baseline_version_id` already
bound through the Application grant, dispatch consumption, operation-5 send
attempt, and operation-5 terminal evidence. It is never accepted from an
operation-14 caller and never inferred from the currently active deployment.

The source version is the exact operation-5
`controller_enabled_version_id`. Source and target versions must be distinct.

The command binds at least:

- authorization, claim, execution plan, operation schedule, and operation-14
  identities;
- Authority database and ledger identities and the current ledger head;
- current lease owner, token, and generation;
- operation-5 terminal and send-attempt identities;
- Controller service, enabled source version, and baseline disabled target;
- Authority and Gateway Worker version identities;
- mutation authority, idempotency, credential, and request identities; and
- `mutation_attempt_limit=1`, `retry_limit=0`, and
  `missing_readback_allows_resend=0`.

## Dynamic receipt capacity

Let `L0` be the claim ledger version immediately before operation 14 starts.

```text
start sequence    = L0 + 1
terminal sequence = current ledger version + 1
```

With no intervening lease event, terminal sequence is `L0 + 2`. If operations
6 through 13 all completed, `L0=21` and operation 14 uses 22/23. If readiness
failed earlier, operation 14 starts from the resulting earlier ledger head.
Hard-coding 22/23 is invalid.

At least twelve receipt slots are reserved before the disable attempt. The
local source guard therefore requires `L0 <= 52`, retaining two operation
receipts plus bounded recovery lease evidence below the protocol limit of 64.
Slot exhaustion fails before a mutation authority or remote request exists.

## Private authority split

Authority accepts two dedicated routes:

```text
POST /internal/v1/shard-placement/execution-claims/{authorization}/disable-controller-deployment
POST /internal/v1/shard-placement/execution-claims/{authorization}/recover-disable-controller-deployment
```

Fresh disable and recovery use different inbound roles and independent gates.
Authority calls the Deployment Gateway only through the private Service
Binding.

The Gateway exposes a separate disable namespace:

```text
POST /internal/v1/controller-deployment-disables/{idempotency}/create-once
POST /internal/v1/controller-deployment-disables/{idempotency}/status-readback
```

Disable create and disable status use independent HMAC roles, key rings, and
remote-only secrets. Existing operation-5 enable credentials do not grant
disable authority.

The Container Controller exposes only a read-only disable attestation route.
Its independent credential cannot wake a DO, start a Container, write D1, or
perform a deployment mutation.

All tracked gates remain false. Production Authority configuration remains
absent until an isolated staging ceremony is accepted.

## Exactly-one mutation authority

The disable state machine is:

1. Read exact immutable evidence and the D1 database clock.
2. Atomically persist the operation-14 attempt, operation-start receipt, and
   first `disable_dispatched` event before external I/O.
3. Only a repository result of `created` owns the single Gateway create call.
4. The Gateway atomically persists its operation and mutation dispatch before
   its only Cloudflare POST.
5. An Authority or Gateway exact replay sends no mutation.
6. Timeout, disconnect, malformed response, 5xx, response loss, or uncertain
   persistence makes the outcome unknown.
7. Once an attempt exists, every later call is status-only. Missing readback
   never authorizes resend.

This proves exactly one mutation authority and at most one remote POST. It
does not claim exactly-once remote effect.

## Disabled deployment evidence

A successful Cloudflare observation requires all of:

- the latest deployment has the exact operation-14 disable annotation;
- the deployment contains one version only;
- that version is the frozen baseline target at 100 percent;
- the baseline version endpoint is readable and structurally valid;
- two different status request identities observe the same canonical
  deployment-state digest;
- the observations are separated by at least the configured stability
  interval; and
- no enabled source, partial rollout, unknown version, pagination ambiguity,
  or deployment drift is present.

A successful Controller attestation requires all of:

- exact Controller service and baseline version identities;
- `controller_enabled=false`;
- `execution_enabled=false`;
- every frozen action gate equals false;
- `all_action_gates_false=true`; and
- the exact canonical action-gate inventory digest.

Gateway `stateDigestSha256` is the canonical deployment-state digest and must
match across the two stable reads. Gateway `observationDigestSha256` also
binds the distinct status request and credential, so it must differ. The
Authority sidecar column named `observation_digest_sha256` stores the state
digest for its D1 stability guard; immutable response and request hashes retain
the complete observation evidence.

An accepted Cloudflare POST, one status observation, process shutdown, an
empty queue, or a healthy Container is not disabled-state proof.

## D1 evidence

Operation 14 uses three append-only sidecars:

1. attempt plus operation-start receipt;
2. chained Gateway mutation and status events; and
3. terminal plus operation-terminal receipt.

Every row has immutable update/delete guards. Generic ordinal-14 start and
terminal receipts are rejected unless a field-identical dedicated sidecar
already exists in the same D1 transaction. The public generic receipt route
also rejects ordinals 4 through 14.

Successful terminal outcomes are `exact_success` or
`ambiguous_recovered`. They atomically project:

```text
status                 = completed
last_completed_ordinal = 14
disable_confirmed      = 1
inflight               = null
```

Rejected or unresolved terminal evidence projects `recovery_required`,
preserves `disable_confirmed=0`, and keeps the active authorization scope
occupied. It does not reopen the execution schedule.

## Failure matrix

| Failure | Required result |
|---|---|
| attempt or start receipt commit fails | no Gateway call |
| Gateway reservation commit fails | no Cloudflare call |
| create response is lost | status-only forever |
| Gateway operation is missing during recovery | unresolved, never resend |
| mutation is rejected | rejected terminal, recovery required |
| deployment is still enabled | continue bounded status-only recovery |
| partial rollout or drift | no success terminal |
| status observations disagree | no success terminal |
| Controller attestation disagrees | no success terminal |
| lease takeover after dispatch | status-only |
| receipt capacity is below reserve | fail before mutation authority |
| recovery deadline expires | unresolved/manual recovery |

## Go/VPS rollback boundary

Operation-14 success is necessary but insufficient for traffic rollback.
Before Go/VPS can receive traffic:

- Rust admission is disabled independently;
- accepted Rust writes are reverse-synchronized;
- ambiguous provider operations are quarantined and never resent by Go;
- billing reservation, settlement, refund, and task terminal ownership are
  reconciled;
- SSE, WebSocket, task pollers, batches, and in-process work are drained;
- audit and WORM evidence is retained; and
- the Go/VPS RTO/RPO and data reconciliation gates independently pass.

Operation 14 never deletes DO, Container, D1, R2, KV, receipt, audit, or
billing evidence.

## Acceptance

Implemented local acceptance includes:

- protocol and cross-service golden vectors;
- concurrent Workerd callers producing one mutation authority and one outbound
  POST while every exact replay is status-only;
- an Authority response-loss path that persists unknown outcome and never
  resends on recovery;
- target, enabled, drift, partial rollout, malformed, stale, and unknown
  observation tests;
- independent HMAC rotation tests for all disable roles;
- D1 behavior tests for normal and early-failure sequence numbers, lease
  events, slot exhaustion, exact deadline boundaries, and generic receipt
  bypass;
- Controller attestation tests proving no binding access or mutation; and
- full Authority, Gateway, and Controller type, dry-run, unit, portable, and
  Workerd gates.

The latest local aggregates pass Authority `118` unit, `7` service-runtime,
`6` Workerd, and `31` config/migration tests; Gateway `30` unit, `4` Workerd,
and `11` config/migration tests; and Controller `179` unit/config, `46`
portable-protocol, and `473` Workerd tests.

Remote acceptance still requires applied D1 schema and normalized-trigger
readback, least-privilege token evidence, N/N-1 credential rotation, remote
commit-response-loss and Worker-rollout campaigns, retained deployment
mutation counts, reverse sync, drain, billing reconciliation, traffic and DNS
rehearsals, and security/SRE approval.
