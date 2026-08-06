# JSON Compatibility Deployment Readback And Mutation Leaves

## Status

This document defines the D0 physical read/write separation implemented on
2026-08-06. The implementation is a local production-oriented foundation. It
does not claim that either Worker, either credential, either D1 database, or
any target service exists in remote staging.

The independent quiesced Reader-only resolver is specified here and in its
dedicated design document. Its signed local v1 protocol, migration 0003,
private Worker, D1 repository, Resolver/status core, focused Node and
Workerd/D1 tests, root scripts, and CI wiring now exist. Signed structured
drain inputs and local contradiction/staleness checks are implemented, but the
independent remote collector, measured maximum-lifetime values, and runtime
fault evidence are incomplete.

All tracked gates are false, all tracked database and credential identities
are placeholders, no public route is configured, and no Cloudflare mutation
was performed. Go/VPS remains authoritative and production remains **NO-GO**.

## Physical Topology

```mermaid
flowchart LR
  O["Owner-signed transition v2"] --> C["Transition Coordinator"]
  C --> S["Source Verifier"]
  C --> R["Deployment Readback Worker"]
  C --> M["Deployment Mutation Worker"]
  R --> RA["Cloudflare read-only API token"]
  M --> MA["Cloudflare mutation-only API token"]
  M --> MD["Independent create-once mutation D1"]
  C --> CD["Coordinator append-only D1"]
  A["Owner recovery authorization + fresh source proof"] --> X["Quiesced Resolution Worker"]
  X --> CD
  X --> R
```

The capability split is structural:

| Service | Secret capability | Storage | Callable method |
| --- | --- | --- | --- |
| Transition Coordinator | none | coordinator D1 | `executeTransition`, D1-only `getTransitionStatus` |
| Deployment Readback | read-only Cloudflare API token | none | `readDeploymentState` |
| Deployment Mutation | mutation-only Cloudflare API token | independent mutation D1 | `mutateDeploymentOnce` |
| Quiesced Resolution Worker | none | append-only resolution tables in coordinator D1 | `resolveDeploymentTransitionInflight`, D1-only `getDeploymentTransitionResolutionStatus`; Reader binding only |

The Coordinator never receives either API token. The Reader has no mutation
binding or D1 mutation journal. The Mutator has no read token and cannot
produce stable target proof. The Resolution Worker must have no Mutator
binding, no Source Verifier binding, and no Cloudflare token or token secret
name. A fresh source proof is supplied in the signed recovery request and is
verified locally.

Service Binding topology is not caller authentication. Any account Worker
that receives a binding could invoke it. Each leaf therefore independently
replays the full owner authorization, and remote promotion additionally
requires an account-wide caller-binding inventory.

## Owner Authority V2

The owner-signed transition request now binds:

- current Plan v5 and state-plan v2;
- the exact frozen transition and all ordered steps;
- complete 18-artifact source inventory readback, not only its digest;
- source authentication roots and the inventory digest;
- Coordinator, Source Verifier, Reader, and Mutator service names,
  entrypoints, version IDs, profile versions, private-RPC flags, capabilities,
  credential identity digests, and service identity digests; and
- the dedicated transition key, audience, issue time, not-before time, and
  expiry.

Reader and Mutator identities are derived from this canonical tuple:

```text
environment + account digest + service + entrypoint + Worker version
+ profile + private-RPC flag + capability + credential ID digest
```

They cannot be supplied as unrelated self-declared hashes. Reader and Mutator
service names, identities, and credential IDs must all differ. The Coordinator
stores the exact authority body and digest in a second immutable D1 table in
the same reservation batch as the operation.

## Reader Boundary

The Reader accepts exactly:

```text
campaignPlan
statePlan
authorizedTransition
sourceAuthentication
readbackRequest
```

Before reading the token binding, it verifies the owner signature, current
authorization window, source proof freshness, operation and plan digests,
exact step and phase, complete artifact inventory, fixed seven-service
allowlist, runtime account identity, credential identity, and its actual
`CF_VERSION_METADATA.id` against the signed Reader authority. Tracked all-zero
identity placeholders are rejected even if the gate is accidentally enabled.

One readback attempt then performs only bounded GET requests:

1. target service deployments;
2. the exact immutable Worker version;
3. target service subdomain and preview state;
4. account Worker custom domains;
5. every page of account-filtered zones in fixed order; and
6. Worker routes for every returned zone.

There is no retry. Redirects are manual, one ten-second deadline covers the
whole attempt, aggregate response bodies are limited to 64 KiB, zone traversal
is limited to eight pages and 128 zones, UTF-8/JSON and pagination are strict,
and each response must contain a bounded request identity. Any network,
deadline, pagination, shape, body, or identity uncertainty returns canonical
v2 `ambiguous` evidence.

The active version ID is joined to the owner-signed immutable artifact
inventory. Live Workers.dev, preview URL, custom-domain, and zone-route state
is reconstructed on every attempt. A non-empty live public route set produces
an observed digest that differs from the required empty digest, so the
Coordinator stops before mutation or refuses target advancement.

The version response is currently used to prove the exact immutable version
and reject unknown/inherited binding shapes. Config, binding, secret-name, and
Durable Object migration digests are projected from the signed inventory once
that exact immutable version is joined. Production therefore still requires
C0/C3 evidence showing how those digests were independently reconstructed
from remote version/config evidence. Synthetic local inventory is not enough.

## Mutator Boundary

The Mutator accepts exactly:

```text
campaignPlan
statePlan
authorizedTransition
sourceAuthentication
mutationIntent
sourceReadbacks
```

Before token access, D1 access, or network access, it independently verifies
the owner signature, source authentication, full inventory, exact authorized
step, both stable source readbacks, Reader service and credential identities,
and the rebuilt mutation intent. It then verifies its actual account, service,
entrypoint, Worker version, profile, credential digest, and derived identity
against the signed Mutator authority. A missing or malformed token fails before
the one-send claim is consumed.

The exact request is derived internally:

```json
{
  "annotations": {
    "workers/message": "cinatoken-json-compatibility-deployment-mutation-v2:<intent-sha256>"
  },
  "strategy": "percentage",
  "versions": [{ "percentage": 100, "version_id": "<target-version>" }]
}
```

The endpoint is the allowlisted account, fixed seven-service target, and
`/deployments` path. `force` is absent. The client performs one raw POST with
manual redirects, no automatic retry, a three-second timeout, and a 64 KiB
response limit. Timeout, transport failure, redirect, 408, 425, 429, 5xx,
oversize body, invalid UTF-8/JSON, or response-shape drift is `ambiguous`.

Before the POST, an independent D1 database atomically creates the exact
mutation claim. The claim binds the owner operation, plans, authority, source
proof, stable source readbacks, intent, target, request body, annotation,
endpoint, Mutator version, and credential identity. Only an unambiguous fresh
insert can send. Conflict, replay, uncertain insert, missing outcome, or
response loss never sends again. Claims and outcomes use D1 time and reject
all updates and deletes.

An accepted API response is not transition success. Only two later Reader
observations of the exact target can advance the state machine.

## Coordinator Integration

The Coordinator now has separate named bindings:

```text
JSON_COMPATIBILITY_DEPLOYMENT_READBACK
JSON_COMPATIBILITY_DEPLOYMENT_MUTATION
JSON_COMPATIBILITY_SOURCE_VERIFIER
```

It checks the signed service names and entrypoints before reserving D1 or
calling a binding. Every Reader and Mutator envelope includes the same complete
owner authorization and source proof, allowing each leaf to validate without
trusting a Coordinator-created summary.

The status RPC remains D1-only. Its v2 response explicitly states that source
verification, Reader calls, Mutator calls, and execution retry were not
performed. Status configuration does not require either leaf binding to be
usable.

Coordinator migration 0002 adds the immutable execution-authority table.
Migration 0001's historical `deployment_leaf_service_name` column is retained
for schema compatibility and stores the Reader service name; migration 0002 is
the authority for the distinct Reader and Mutator identities.

## Quiesced Resolution Boundary

The resolver is a separate private Worker because retaining a Mutator binding
inside a recovery code path would not prove Reader-only capability. It owns no
normal transition RPC and cannot call the Source Verifier. Its strict request
contains a dedicated Ed25519 owner recovery authorization plus a fresh source
proof produced by an independent recovery ceremony.

The recovery authorization binds the original operation and execution
authority, exact event count and journal-head digest, expected claim
generation, final Resolver and Reader service/version/identity and Reader
credential digests, fresh source-proof digest and approved verifier identity,
execution-disabled evidence and caller-topology digest, the complete audited
drain calculation, `quiescenceSatisfiedAt`, observation stability interval,
and a lease bounded by both authorization and proof expiry.

Resolution cannot start merely because a gate now reads false. Operators must
disable execution, independently read back that exact Coordinator version and
account-wide caller topology, wait longer than the maximum lifetime of every
already admitted request plus propagation and clock-skew allowance, and repeat
the readback. Without this quiescence, an old Coordinator request could have
persisted `mutation_intent` and still be about to invoke the Mutator after a
resolver claim.

The Resolver atomically appends one D1 claim for the signed generation and
journal head. It then appends exactly two target observations from the pinned
Reader with the signed minimum spacing before creating one independent
resolution receipt. Distinct request IDs are required for stable/manual
conclusions; duplicates are retained only as inconclusive evidence. All rows
are create-only;
updates/deletes fail, identity ledgers reject `INSERT OR REPLACE` recreation,
generations cannot share observations, old generations cannot append after a
newer claim, and normal and resolution receipts are mutually exclusive.

Claim, observation, or receipt response loss is reconciled only by exact
digest readback. A lost Reader response is not synthesized or automatically
retried. The Resolver never writes a normal mutation outcome, never fabricates
a normal transition receipt, never resends a deployment, and never continues
the interrupted step sequence. Both `target_confirmed` and
`manual_review_required` final receipts set `nextTransitionAllowed=false`. An
ambiguous or unstable pair may create only non-final `readback_inconclusive`
evidence and grants no retry authority. Manual review can be addressed only
with newly observed prior state and a newly signed operation, never by
reopening the old operation.

See
`docs/container-runtime-json-compatibility-deployment-resolution.md` for the
complete state machine, authorization fields, SQL invariants, test matrix, and
remote ceremony.

## Local Acceptance

The focused gates are:

```text
bun run check:container-runtime:json-compatibility-deployment-transition
bun run check:container-runtime:json-compatibility-deployment-readback
bun run check:container-runtime:json-compatibility-deployment-mutation
bun run check:container-runtime:json-compatibility-deployment-transition-worker
bun run check:container-runtime:json-compatibility-deployment-resolution
```

Current local evidence:

| Gate | Result |
| --- | --- |
| shared transition protocol | 14 tests, 157 expectations |
| Reader | 15 tests; TypeScript and generated types pass |
| Reader Wrangler dry-run | 281.35 KiB upload / 47.02 KiB gzip, both gates false |
| Mutator Node | 19 tests |
| Mutator Workerd/D1 | 2 tests |
| Mutator Wrangler dry-run | 255.55 KiB upload / 42.96 KiB gzip, both gates false |
| Coordinator Node | 8 tests |
| Coordinator Workerd/D1 | 2 tests, four concurrent calls, one operation, four mutations, 16 reads |
| Coordinator Wrangler dry-run | 294.87 KiB upload / 48.48 KiB gzip, all gates false |
| Resolver protocol | 4 tests, 17 expectations, including resealed receipt tampering |
| Resolver Node | 14 tests, including 20-way claim concurrency, proof-bounded lease rejection, N+1 after an inconclusive attempt, journaled-outcome reconstruction, final-write response loss, forbidden capability inventory, stale/contradictory drain evidence, and unbound Reader-response identity rejection before observation persistence |
| Resolver Workerd/D1 | 4 tests, including 20-way claim concurrency, post-outcome and malformed checkpoints, operation-digest replay binding, zero/one-observation rejection, duplicate/mixed/stable classification, spacing, fencing, identity ledgers, and `INSERT OR REPLACE` rejection |
| Resolver generated types, TypeScript, Wrangler dry-runs | pass; 336.81/54.04 KiB upload/gzip, one D1 and one Reader binding, all gates false |

The complete repository `bun run check` passes with exit code 0 in 1,462.3
seconds after this hardening, covering the configured frontend,
Worker/Workerd, supply-chain, D1, Rust workspace, and wasm32 gates.

The Coordinator runtime test uses physically distinct Reader and Mutator mock
Workers. It proves separate call counts, exact terminal replay without leaf
effects, D1-only status, and immutable operation, authority, event, and receipt
tables. The Mutator runtime test applies its actual migration and proves
concurrent claim linearization. Reader tests inject bounded HTTP responses and
do not call Cloudflare.

The Resolver authorization binds the exact fresh source-proof digest, and both
Resolver and Reader reject a valid substituted proof before D1, token, or
network access. Its package aggregate test is green, root `check`/`build:all`
and focused CI include it, and terminal receipt response-loss replay performs
no extra Reader call. The structured local evidence contract is signed and
validated; independent remote collection/re-read, measured policy values,
wider claim/observation fault coverage, and remote evidence remain open. The
Workerd runtime is pinned to its supported `2026-07-15` compatibility date,
while deploy dry-runs consume the tracked `2026-08-06` profiles; upgrading the
runtime and proving exact-date parity remains explicit toolchain debt. No local
result is remote Cloudflare proof.

## Remote Staging Sequence

Do not combine or reorder these steps:

1. Complete and independently approve C0-C4 source, credential, external WORM,
   stable account, and source-publication evidence.
2. Issue distinct short-lived least-privilege Reader and Mutator credentials.
   Retain signed creation, permission, custody, verification, and revocation
   evidence. Never place a token in argv, tracked config, logs, or receipts.
3. Provision the independent Mutator D1 and Coordinator D1 through the D1
   create-once ceremony. Apply exact migrations and independently read back all
   tables, columns, indexes, triggers, foreign keys, and migration heads.
4. Deploy the final private Reader, Mutator, Source Verifier, and Coordinator
   candidate versions with real non-secret identity anchors and their intended
   gates. Do not invoke transition execution. Independently read back version,
   exports, bindings, routes, Workers.dev, previews, secret names without
   values, and D1 bindings.
5. Build the owner execution authority only from those final deployed version
   IDs. Changing a gate or binding creates a different candidate and requires
   a new readback and signature.
6. Prove account-wide caller topology: only the reviewed Coordinator version
   may call Mutator; only the reviewed Coordinator and Resolution Worker
   versions may call Reader; no unreviewed Worker may hold either binding.
7. Upload and independently read back all 18 service artifacts dark. Rebuild
   config, binding, route, gate, secret-name, and migration digests using the
   approved C0/C3 normalization.
8. Complete and locally approve the remaining independent Resolver gates.
   Implement independent drain-evidence collection/re-read, freeze measured
   policy values, extend claim/observation and multi-generation fault coverage,
   and prove its configuration has no Mutator, Source Verifier, token, or
   public-route capability.
9. Run disabled and status-only probes, then concurrency, crash, timeout,
   response-loss, pagination drift, public-route drift, wrong-version,
   credential-rotation, N/N-1, and post-send D1 ambiguity tests.
10. Disable execution and independently read it back, drain the audited maximum
    request lifetime, repeat configuration and caller-topology readback, then
    obtain a fresh source proof and one owner-signed recovery generation.
11. Run resolver claim/observation/receipt response-loss, wrong-version,
    generation, lease, quiescence, drift, and concurrent resolver tests. Prove
    zero mutation resend and publish the independent resolution receipt to the
    locked archive before the first real transition.
12. Execute the four transitions only inside isolated staging with Go/VPS
    authoritative and an independently approved rollback decision path.

## Remaining D0 Blockers

D0 is not production-complete until remote evidence proves:

- real least-privilege credentials and distinct credential identities;
- final Resolver, Reader, Mutator, Source Verifier, and Coordinator Worker
  versions and exact configuration readback;
- complete live public-route absence and caller-binding topology;
- independently derived immutable config, binding, secret-name, and Durable
  Object migration digests for every signed artifact inventory entry;
- applied and independently read Mutator and transition D1 schemas, including
  the exact resolution migration 0003;
- actual one-send API request and response-loss evidence without retry;
- credential rotation/revocation and wrong-version negative drills;
- implemented and remotely proven quiesced Reader-only inflight resolution,
  including owner recovery signing, fresh source-proof delivery, physical
  capability inventory, execution disable/readback/drain evidence,
  concurrency/response-loss/wrong-version tests, and locked independent
  resolution-receipt publication; and
- security, privacy, SRE, release, rollback, campaign, and cutover approval.

Local tests and Wrangler dry-runs establish implementation behavior only. They
grant no Cloudflare deployment or traffic authority. The Resolver foundation
does not establish a complete production Resolver or remote implementation
evidence.
