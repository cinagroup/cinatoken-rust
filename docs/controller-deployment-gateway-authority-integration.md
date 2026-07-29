# Authority to Controller Deployment Gateway Integration

## Status

This document defines the local production contract for the operation-5
Authority-to-Gateway boundary. The implementation is complete locally and
default-off. It has not been deployed, has not read Cloudflare remote state,
and has not used a Cloudflare API token.

Go/VPS remains authoritative. Production remains **NO-GO**.

## Trust boundary

The control plane is split deliberately:

```text
workload
  -> shard-placement-authority
       -> private Service Binding
            -> controller-deployment-gateway
                 -> Cloudflare deployments API
                 -> Cloudflare versions API
```

- Authority owns the execution claim, immutable send authority, and the
  append-only operation-5 evidence chain.
- Gateway alone may receive the future least-privilege Cloudflare deploy and
  read tokens.
- Authority has separate create and status HMAC identities for Gateway.
- Gateway create and status identities cannot reuse a KID, credential digest,
  or secret.
- The private Service Binding has no public route, custom domain,
  `workers.dev`, or preview ingress.
- Controller, Durable Objects, Containers, the edge Worker, and Authority do
  not receive the Cloudflare deployment credential.

Cloudflare Service Bindings are used as the private transport. Requests are
constructed with a fully qualified internal URL and sent through
`env.CONTROLLER_DEPLOYMENT_GATEWAY.fetch(request)`.

## Create authority

The existing Authority route remains:

```text
POST /internal/v1/shard-placement/execution-claims/{authorization_id_sha256}/start-enable-dispatch-send
```

It requires:

- inbound Authority `send` HMAC;
- `SHARD_PLACEMENT_AUTHORITY_SEND_ATTEMPT_WRITE_ENABLED=true`;
- `SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED=true`;
- `SHARD_PLACEMENT_AUTHORITY_GATEWAY_CREATE_ENABLED=true`;
- complete, pairwise-isolated Gateway create/status credentials; and
- the exact live, non-recovered dispatch-consumption receipt.

Before any Service Binding call, one first-primary D1 batch inserts:

1. the immutable operation-5 send attempt;
2. sequence 1 `send_started`; and
3. sequence 2 `gateway_create_dispatched`.

The third event means:

```text
unique_gateway_create_authority_persisted_network_may_not_have_occurred
```

The batch is the sole create authority. Only a definite new three-row result
may call Gateway create. A caught D1 error, indeterminate result, concurrent
winner, exact replay, partial readback, or divergent readback cannot call it.

The Gateway request binds:

- authorization digest;
- Authority attempt digest;
- `send_started` event digest;
- frozen Controller command digest;
- deterministic Gateway idempotency digest;
- deterministic Cloudflare deployment mutation digest;
- create credential digest; and
- Gateway request-ID digest.

Authority independently reconstructs the canonical Cloudflare deployment body
and verifies the mutation digest returned by Gateway. This prevents a validly
signed Gateway response from substituting a different deployment body.

## One-shot create result

Authority performs one Service Binding call with:

- canonical JSON no larger than 4 KiB;
- manual redirect handling;
- a 3-second budget;
- a 64 KiB bounded JSON response;
- `Cache-Control: no-store`;
- an exact response field set; and
- no client retry.

The result is appended at sequence 3 as one of:

- `gateway_create_accepted`;
- `gateway_create_rejected`; or
- `gateway_create_ambiguous`.

Transport failure, timeout, invalid response, response loss, and unknown
Gateway outcome are persisted as ambiguous with `status_only` recovery. If
the remote call completed but Authority cannot append sequence 3, the request
fails. Replaying the start route still performs zero create calls because the
three-row create authority already exists.

The start response distinguishes:

- whether this Authority invocation called Gateway;
- whether Gateway reports a remote mutation was sent;
- accepted, rejected, ambiguous, or no recorded classification;
- `status_readback` versus `status_only`; and
- the latest persisted Gateway event sequence and digest.

## Status-only recovery

Authority exposes:

```text
POST /internal/v1/shard-placement/execution-claims/{authorization_id_sha256}/read-enable-dispatch-status
```

It requires:

- inbound Authority `recovery` HMAC;
- `SHARD_PLACEMENT_AUTHORITY_GATEWAY_EVENT_WRITE_ENABLED=true`;
- `SHARD_PLACEMENT_AUTHORITY_GATEWAY_STATUS_READ_ENABLED=true`; and
- the exact attempt, command, idempotency, claim, and inbound request-ID
  digests.

The route reconstructs and re-hashes the frozen Controller command from the
immutable attempt. It reads the entire bounded operation-5 Gateway event chain
and validates contiguous sequence and predecessor digests.

If a crash left only sequence 2, recovery first appends sequence 3
`gateway_create_ambiguous`. It does not call create. It then invokes only the
Gateway status endpoint, which is constrained to Cloudflare deployment-list
and target-version GETs.

Each status result appends:

- `gateway_status_target`;
- `gateway_status_baseline`;
- `gateway_status_drift`;
- `gateway_status_ambiguous`; or
- `gateway_status_stable`.

An exact replay of the same Authority status request reads its existing event
and performs zero Gateway calls. A crash after the Gateway status call may
repeat only the status request; Gateway replays its immutable observation and
never sends a mutation.

## Stable target

Authority records stable only when all conditions hold:

1. Gateway reports `targetStable=true`.
2. The current observation is `target_observed`.
3. The immediately preceding Authority event is also target-observed.
4. Both observations have the same observation digest.
5. The observations are separated by the configured 5-to-120-second stable
   window.
6. Both Gateway responses, versions, request identities, and observation
   timestamps are persisted.

The same observation digest is intentionally allowed in consecutive rows.
Stability means the same target state was observed twice; a global uniqueness
constraint on that digest would make stable evidence impossible.

Baseline, drift, ambiguous, or a changed target digest resets the Authority
stability chain.

## Event state machine

```text
send_started
  -> gateway_create_dispatched
       -> gateway_create_accepted
       -> gateway_create_rejected
       -> gateway_create_ambiguous
            -> gateway_status_target
            -> gateway_status_baseline
            -> gateway_status_drift
            -> gateway_status_ambiguous
            -> gateway_status_stable
```

Migration 0006 stores Gateway-specific fields in a side table and projects
each insert into the existing migration-0005 send-attempt event stream.
Migration 0005 rows are not rewritten. Both tables deny update and delete.

Every appended event requires:

- one continuous predecessor;
- exact attempt, command, and idempotency identity;
- create/status credential role isolation;
- bounded response evidence;
- event-kind-specific nullability;
- D1-owned insertion time; and
- a canonical event digest.

## Failure matrix

| Failure point | Durable Authority state | Permitted recovery | Create resend |
|---|---|---|---|
| Before three-row D1 batch | None | Retry start | No prior send |
| D1 batch definitely fails | None | Retry start | No prior send |
| D1 commit response lost | Exact triple or none | Exact readback | Never from replay |
| After triple, before Service Binding | Through dispatch | Status-only | Never |
| During Gateway create | Through dispatch | Append ambiguous, status-only | Never |
| Gateway response lost | Through dispatch | Append ambiguous, status-only | Never |
| Sequence-3 append fails | Gateway may have mutated | Status-only on replay | Never |
| Status transport fails | Existing create chain | New status request | Never |
| Status event append fails | Existing create chain | Repeat status-only | Never |
| Worker rollout/restart | Immutable D1 chains | Read and resume | Never |
| Baseline or drift observed | Exact status evidence | Operator policy | Never |

## Gate order

No action gate may be enabled before migration and identity evidence is
independently read back.

For the first staging ceremony:

1. Confirm old Authority code and every placement/Gateway gate are false.
2. Apply Gateway migration 0001 and the backward-compatible Authority
   migration 0006 before deploying code that requires the new schema.
3. Read back exact tables, columns, indexes, triggers, and normalized trigger
   SQL.
4. Deploy Gateway and Authority code with every action gate still false.
5. Provision Gateway create/status HMAC secrets and deploy/read API tokens by
   stdin-backed secret operations.
6. Prove Service Binding targets and absence of public ingress.
7. Enable Gateway remote read and status gates only.
8. Enable Authority Gateway event write and status-read gates.
9. Run baseline, target, drift, outage, and two-observation stability probes.
10. Enable Gateway remote mutation/create for one approved synthetic target.
11. Enable Authority Gateway create last.
12. Execute one authorization and immediately disable Authority create.
13. Complete status-only readback and archive redacted evidence.

The event-write gate is opened before either caller gate. Status read is
opened before create so every ambiguous create has a recovery path.

## Rollback

Rollback never deletes evidence or repeats create:

1. Disable Authority Gateway create.
2. Disable Gateway remote mutation and create.
3. Keep Authority/Gateway status read available for in-flight readback.
4. Classify target, baseline, drift, or ambiguity from immutable evidence.
5. Use a separately authorized rollback operation; do not reinterpret
   operation-5 create as rollback authority.
6. Disable status reads after all in-flight attempts are terminally classified.

An old Authority version that does not understand migration 0006 must remain
disabled after 0006 is applied. Rollback is code-forward with gates closed,
not a schema downgrade.

## Observability

Production evidence must record only non-secret identities:

- Authority attempt and event digests;
- Gateway request and response digests;
- create/status credential digests, never secrets;
- Gateway and Authority Worker version IDs;
- result and status classifications;
- stable-window timestamps;
- D1 request IDs and normalized errors; and
- the observed count of Cloudflare mutation POSTs.

Acceptance requires mutation POST count `<= 1` for every attempt across fault
injection, replay, restart, concurrency, and rollout campaigns.

## Remaining P0

Local integration does not yet close operation 5 in the execution claim.
`gateway_status_stable` is durable evidence, but a dedicated terminal receipt
must still atomically bind:

- the stable Gateway event digest;
- operation-5 operation ID;
- claim and ledger head;
- Controller enabled version;
- Authority and Gateway Worker versions; and
- the next operation ordinal.

That terminal transition must be exact-replay safe and must reject baseline,
drift, ambiguous, stale, or non-consecutive observations.

Remote schema readback, least-privilege token proof, credential rotation,
fault campaigns, operation-5 terminal closure, operations 6-14, reverse sync,
drain, traffic and DNS cutover, and security/SRE approvals all remain open.
