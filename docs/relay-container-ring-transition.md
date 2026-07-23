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

## Offline Signed Manifest Contract

The separately reviewed record is now executable as a strict offline contract:

```text
manifest: cinatoken-relay-container-ring-transition-manifest-v1
policy:   cinatoken-relay-container-ring-transition-trust-policy-v1
evidence: cinatoken-relay-container-ring-transition-evidence-v1
domain:   cinatoken-relay-container-ring-transition-approval-v1
decision: isolated-staging-adjacent-ring-transition
```

The canonical manifest envelope contains `schemaVersion`, `contract`,
`subject`, `subjectDigestSha256`, and `approvals` only. Its signed subject binds:

- the strict P5 candidate schema and candidate digest, including source commits,
  Worker versions, image/build/provenance/SBOM, D1/KV/R2/Service/DO identities,
  current ring, schema head, and protocol versions;
- a canonical candidate-foundation artifact binding candidate-freeze, source
  audit, build provenance, and foundation-capture digests while explicitly
  claiming no remote promotion or transition evidence;
- previous/current generation and shard count, absolute admission timestamps,
  cutoff safety margin, Container `max_instances`, routing-contract digest,
  routing/authority key IDs, and irreversible high-entropy key fingerprints;
- a fresh canonical old-ring readback artifact produced by a separately
  authenticated collector, whose old edge and Controller version/deployment
  sets, Rust commit, resource identities, Container image, runtime
  build/provenance/SBOM, provider-egress version, migration head/count,
  protocol versions, key IDs, and key fingerprints match the new candidate;
  only edge/Controller deployment identity and ring generation/count may differ;
- a synthetic, non-streaming, no-customer, no-paid-provider cohort of at most
  100 operations;
- canonical capacity-readback, observability-plan, rollback-packet, and
  credential-revocation artifacts with exact candidate digest, byte count,
  file digest, capture time, expiry, pass status, and kind-specific facts;
- a short-lived canonical Go/VPS hot-fallback artifact tied to the same Go and Rust commits.
  It must state that Go/VPS remains the traffic and scheduler authority and that
  ingress drain and process shutdown are not authorized.

The Go/VPS fallback record is deliberately not the production-cutover packet.
The latter proves a different ceremony, Go/VPS to Cloudflare authority transfer,
and would create a circular and unsafe precondition here. Transition execution
evidence is collected after the window and may later feed the independent P5
and production-cutover packets.

The candidate-foundation artifact and P5-B are different immutable packets.
The former is a pre-transition freeze/source/build input and contains no claim
about remote rollout or dual-ring execution. Full P5-B is created only after
the transition and binds overlap, cutoff, lifecycle, financial, load, and
rollback results. P5-B can never be substituted into the preflight timeline
retroactively.

### Approval and validation boundary

The trust policy is canonical JSON outside the manifest bundle and contains
public keys only. Security, finance, operations, product, and rollback each sign
the transition-specific message with a distinct Ed25519 key and distinct public
key material. A P5 signature cannot be replayed because the approval domain is
different. Every signature must follow the complete evidence, precede admission
start, and remain valid through the signed decision expiry.

Verification fails closed unless all of the following hold:

- `current_generation = previous_generation + 1`;
- `1 <= previous_count < current_count <= 1024`;
- the current ring exactly matches the signed candidate and candidate-foundation
  artifact;
- the old-ring artifact matches every frozen artifact/resource/schema/protocol/
  key field, including key fingerprints, and its ring matches `G/N`;
- `max_instances >= current_count`;
- the whole-second admission window is 30 through 900 seconds;
- verification has at least 300 seconds of lead time and the complete window
  fits the manifest, policy, all evidence artifacts, Go/VPS fallback, and
  approval validity windows;
- the routing contract is exactly HMAC-SHA256 plus Jump Consistent Hash v1 with
  the canonical instance prefix and 1024-shard maximum;
- customer traffic, paid provider calls, remote mutation, production cutover,
  secret rotation, generation rollback, Go/VPS shutdown, and credential
  material are all explicitly unauthorized.

The manifest, policy, and all seven fixed evidence artifacts must be canonical
JSON plus one newline, bounded regular single-link files with stable identity
across the open/read/stat sequence and no symbolic link. Artifact paths are
fixed below `evidence/`; the verifier reads and hashes the actual bytes, checks
every capture/expiry against the signed decision, and validates capacity,
observability, rollback, revocation, previous-ring, foundation, and fallback
semantics. Unknown
or missing fields, digest drift, shared keys, expired evidence, fractional
timestamps, or unsafe authority booleans are rejected.

Run the contract description without credentials or remote access:

```powershell
bun run plan:relay-container:ring-transition
```

Verify a prepared packet and its seven referenced evidence artifacts:

```powershell
bun tools/verify_relay_container_ring_transition.mjs `
  --manifest <transition-manifest.json> `
  --trust-policy <transition-trust-policy.json> `
  --json
```

The only positive result is
`eligible-for-isolated-staging-adjacent-ring-transition-review`. The verifier
reads no credential environment variable, performs no network request, starts
no subprocess, writes no file, and emits no executable deploy command. Its
declarative Controller/edge overlay and plan digest are review material only;
all deploy, traffic, provider, production, and mutation authorities remain
false. Archive output includes the trust-policy digest and approval public-key
fingerprints so a later reviewer can identify the exact trust anchor.

### Relationship to ordinary deploy preflight

The ordinary Controller deploy preflight continues to require all four
previous-ring variables to be `0`. A valid transition result does not call,
replace, satisfy, or bypass that gate and never edits tracked Wrangler config.
A future mutation-capable transition runner requires a separate contract,
revoked-credential proof, authenticated remote identity readback, and an
operator ceremony. Local, staging, and production tracked defaults remain zero.

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

This is a future mutation ceremony, not an action granted by the offline
decision. Steps 4-8 remain blocked until a separate mutation authorization
verifies credential revocation, remote identities, operator presence, and the
same manifest/plan/policy digests. In this section, "approved" means that later
authorization, never merely `eligible-for-...-review`.

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
   authenticated status readback reports `ring_transition_configured=true`,
   `ring_transition_valid=true`, and the exact previous ring/window. Old edge
   traffic now enters as `previous_admit`.
5. **Edge second.** Deploy the edge with `G+1/M` and the unchanged routing
   secret. Require authenticated Controller status readback before admitting the canary. Stop
   rollout if any edge still emits previous-ring new operations inside the
   five-second cutoff margin.
6. **Canary and expansion.** Prove old/new overlap on shared shard indices,
   movement only to newly appended shards, capacity bounds, cold/warm lifecycle,
   one mock-provider attempt, exact D1/DO/R2/billing conservation, and no cross-ring
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

- authenticated Controller status artifacts before, during, and after the
  window, each canonically hashed into the evidence packet;
- every current shard ready, exact Controller version and runtime build;
- real-tenant routing distribution and Jump Hash movement bounds;
- old/new shared-DO overlap with restart, eviction, sleep, timeout, and capacity
  faults;
- cutoff new-claim rejection plus exact replay, status, recovery, and ACK proof;
- D1/DO/R2/provider/billing/audit conservation with no duplicate side effect;
- load, latency, CPU, memory, Container start rate, cost, alert, and soak data;
- Go/VPS traffic rollback and forward-only recovery rehearsal;
- reviewed post-transition P5-B, security, privacy, finance, SRE, migration, and
  rollback packets.

These are post-transition outputs. They cannot be substituted for the manifest
inputs above or claimed in advance. A failed or incomplete output packet keeps
all further promotion gates false and routes new traffic to the retained Go/VPS
authority.

Local tests establish parser, bounded-window, adjacent-ring, replay-only, and
DO overlap behavior. They do not establish Cloudflare propagation timing,
Container lifecycle, provider behavior, billing correctness under remote
faults, or production eligibility.
