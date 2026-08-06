# Quiesced Reader-Only Deployment Resolution

Date: 2026-08-06

Status: reviewed production design plus an implemented and hardened local v1
foundation.
The current worktree contains the signed protocol and recovery readback
helpers, migration 0003, a private Reader-only Worker, D1 repository,
Resolver/status core, Node and Workerd/D1 tests, root scripts, and focused CI
wiring. The signed structured execution-disable/drain evidence contract and its
local negative matrix are implemented. Independent remote collection,
maximum-lifetime measurement, broader response-loss/multi-generation coverage,
and Cloudflare evidence are not complete. Go/VPS remains authoritative and
production remains **NO-GO**.

## Purpose

The deployment transition journal can remain inflight when execution loses a
response or crashes after reserving an operation. Re-executing that operation
could send the same non-idempotent deployment mutation twice. The resolver
therefore answers only one question: what target state can two independent,
stable, read-only observations prove after execution has been disabled and all
possible old executors have drained?

The resolver never resumes the transition, never reconstructs a missing
Mutator response, and never authorizes another transition. Its terminal output
is a separate resolution receipt with `nextTransitionAllowed=false`.

## Physical Capability Boundary

The resolver is a separate private Worker, not another method on the
Coordinator:

```text
owner recovery authorization + fresh source proof
  -> private Resolution Worker
     -> shared transition D1
     -> private Deployment Reader Service Binding
        -> read-only Cloudflare API credential

Resolution Worker has no:
  - Deployment Mutator binding
  - Source Verifier binding
  - Cloudflare API token or other deployment credential
  - public route, workers.dev endpoint, or preview URL
  - normal transition execution method
```

The fresh source proof is produced and delivered by the independently approved
recovery ceremony. It is an input to the resolution request, not a capability
held or fetched by the Resolver. The Resolver verifies its signature, age,
source roots, operation binding, and exact approved Source Verifier identity
locally before D1 or Reader access.

The local Worker shell exports only `resolveDeploymentTransitionInflight` and
the D1-only `getDeploymentTransitionResolutionStatus`. Its default export is
inert. Tracked master, execution, and status-read gates remain false. The
tracked Wrangler configuration contains exactly one service binding, the
Reader, plus Version Metadata and the transition D1 binding. It contains no
Mutator or Source Verifier binding and no token variable or secret name.

This physical separation is part of the security proof. A TypeScript branch
that promises not to call a Mutator while retaining the binding is not an
acceptable Reader-only resolver.

## Why Quiescence Is Mandatory

D1 can linearize a resolution claim, but it cannot cancel an execution request
that already appended `mutation_intent` and is about to invoke the independent
Mutator. Claiming resolution while such a request can still run would allow a
readback to race a late mutation.

Resolution is therefore allowed only after this ceremony:

1. Disable normal transition execution on the exact deployed Coordinator
   candidate. Status remains read-only.
2. Independently read back the disabled execution gate, Coordinator version,
   configuration, bindings, private-route state, and account-wide caller
   topology.
3. Record the last time any execution-capable version could have admitted a
   request.
4. Wait the policy-pinned drain interval. It must exceed the audited maximum
   lifetime of an already admitted execution, all nested Service Binding and
   Cloudflare deadlines, platform propagation allowance, and clock-skew
   allowance.
5. Re-read the disabled configuration and caller topology. Any drift restarts
   the ceremony and drain interval.
6. After the drain completes, obtain a fresh source proof and sign a dedicated
   owner recovery authorization for one operation, journal head, and claim
   generation.

The evidence attachment contains `executionDisabledAt`,
`maximumAdmittedRequestLifetimeSeconds`, `propagationAllowanceSeconds`,
`clockSkewAllowanceSeconds`, their exact `requiredQuiescenceSeconds` sum,
`quiescenceSatisfiedAt`, `observedAt`, Coordinator identity/configuration, and
caller-topology digests. The authorization binds its canonical digest, required
interval, and boundary times. The Resolver rejects a
claim before D1 or Reader access when current time precedes
`quiescenceSatisfiedAt`, evidence is stale or inconsistent, execution is not
proved disabled, or the lease extends beyond any authorization or proof
window.

Quiescence is an operational safety invariant, not a best-effort delay. Until
remote fault campaigns establish the maximum lifetime and prove the complete
disable/readback/drain sequence, inflight resolution remains production
**NO-GO**.

## Recovery Authorization

Resolution uses a dedicated Ed25519 owner recovery authorization. A normal
transition approval, Operator phase approval, source proof, status request, or
previous recovery authorization cannot substitute for it. The recovery
contract uses its own signature domain, audience, subject, schema version,
request digest, nonce, and bounded validity window.

The signed body binds at least:

- the original operation ID digest, authorized-request digest, Plan v5 digest,
  state-plan v2 digest, transition ID, and immutable execution-authority
  digest;
- the exact append-only journal snapshot: event count, head ordinal, head event
  digest, and canonical journal-head digest;
- the expected recovery generation and one recovery-attempt digest;
- the expected source and target state digests for the interrupted step;
- the exact Resolver service, entrypoint, Version Metadata ID, profile,
  private-RPC flag, capability, and derived service-identity digest;
- the exact Reader service, entrypoint, Version Metadata ID, profile,
  private-RPC flag, read-only capability, credential-identity digest, and
  derived service-identity digest;
- the fresh source-proof digest, approved Source Verifier identity, proof
  issue time, proof expiry, and source roots;
- the execution-disabled evidence digest, disabled Coordinator version and
  configuration digest, caller-topology digest, observation time, exact audited
  drain inputs, their required sum, and `quiescenceSatisfiedAt`;
- `settleNotBefore`, fixed claim-lease duration, owner authorization
  issue/not-before/expiry times, and the observation stability window; and
- `automaticRetries=0`, `mutationAllowed=false`,
  `sourceVerifierCallAllowed=false`, and `nextTransitionAllowed=false`.

`leaseExpiresAt` must be no later than the owner authorization expiry or fresh
source-proof expiry. The claim generation is not selected by the Resolver. An
expired or failed generation requires a new fresh source proof and a newly
signed owner recovery authorization for generation `N+1` and the then-current
journal head.

The original transition approval may be expired. It is revalidated as an
immutable historical signature and operation binding, without treating its
old mutation window as current authority. Only the fresh recovery
authorization grants bounded read-only resolution authority.

## Admissible Journal Checkpoints

The Resolver first reads one consistent D1 snapshot of operation, execution
authority, ordered events, normal receipt, resolution claims, observations,
and resolution receipt. It does not assemble status from unrelated SELECT
results that may observe different commits.

Resolution can be claimed only when:

- the exact operation and immutable execution authority exist;
- no normal transition receipt exists;
- no terminal resolution receipt exists;
- the event chain is canonical, contiguous, and exactly matches the signed
  journal head;
- the head represents an audited inflight checkpoint at or after a persisted
  `mutation_intent`, or after a persisted `mutation_outcome` but before stable
  target proof or normal receipt;
- no unexpired unresolved claim for the operation exists; and
- the requested generation is exactly the next admissible generation.

An unknown event kind, detached intent, mismatched step, event gap, receipt
race, authority drift, or journal-head drift fails closed. The Resolver never
repairs execution events and never appends a normal `mutation_outcome`.

## Append-Only D1 State

Local migration
`0003_json_compatibility_deployment_transition_resolution.sql` adds separate
resolution tables to the existing transition D1. Existing migrations are not
rewritten. The migration is local worktree evidence until it passes the full
runtime matrix and is applied and independently read back remotely.

### Resolution claims

One create-only row binds the operation, generation, owner recovery
authorization digest, journal head, Resolver and Reader identities, fresh
source-proof digest, execution-disabled evidence digest,
`quiescenceSatisfiedAt`, claim time, stability interval, and lease expiry.

Claim election uses one conditional `INSERT ... SELECT`, followed by exact
first-primary readback. The
predicate checks the exact journal head, absence of either terminal receipt,
absence of an unexpired unresolved claim, expected generation, quiescence, and
lease. Concurrent requests can create at most one claim. A lost D1 response is
reconciled by reading the exact claim digest; it does not create a second
generation.

After a claim is created, SQL triggers permanently reject new normal execution
events and a normal transition receipt for that operation. This is a durable
fence after quiescence; it is not a replacement for draining already admitted
executors.

### Target observations

Each generation can append exactly two target observations with
ordinals 1 and 2. Every row binds the full canonical Reader result, request ID,
observed semantic state digest, Reader service/version/identity and credential
identity digests, observation time, prior observation digest, and claim digest.

Both observations must use the authority-pinned Reader and be separated by at
least the signed stability interval. Distinct request IDs are required for a
stable or manual-review conclusion; a duplicate ID is retained only as
`readback_inconclusive`. The second observation must be inside the claim lease
and source-proof lifetime. Observations from different generations can never
be combined.

There is no automatic Reader retry. If a Reader response is lost before its
observation is durably appended, the Resolver does not guess or synthesize it.
The attempt remains inflight until its lease expires; another attempt needs a
new owner-signed generation. A lost append acknowledgement is resolved only by
exact digest readback.

### Resolution receipts

A final create-only row stores a canonical, independently typed resolution
receipt. It binds the operation, claim, recovery authorization, original
journal head, both observation digests, classification, reason code, evidence
counts, zero retries, `mutationResent=false`,
`normalMutationOutcomeSynthesized=false`, and
`nextTransitionAllowed=false`.

The allowed final classifications are:

| Classification | Required evidence | Effect |
| --- | --- | --- |
| `target_confirmed` | two stable observations exactly match the signed target state | closes uncertainty only; does not create a normal receipt or authorize the next transition |
| `manual_review_required` | two stable observed responses agree on the same non-target state, including a stable source or intermediate state | absorbs the original operation; any later action needs a new operation and signature |

An attempt may also append a non-final `readback_inconclusive` resolution
receipt for bounded ambiguous or unstable evidence. It never means success,
never permits a transition, and does not authorize an automatic repeat. A new
attempt still requires lease completion, a fresh source proof, and a newly
signed generation.

Ambiguous Reader results may produce only `readback_inconclusive`; a lost
Reader response, D1 unavailability, or lease expiry cannot produce a
successful resolution receipt. They leave an immutable attempt trail and
require a newly authorized generation. Wrong Resolver,
Reader, credential, source-proof, execution-disabled evidence, or journal-head
identity fails before terminal sealing.

All resolution tables reject update and delete. Append-preserved identity
ledgers also prevent SQLite `INSERT OR REPLACE` from deleting/recreating claim,
observation, or outcome identities when recursive triggers are disabled. An
operation can have at most one final resolution receipt, and normal and
resolution receipts are mutually exclusive. Receipt-commit response loss is
reconciled by exact digest readback.

## Receipt And Status Semantics

A resolution receipt is not a normal transition receipt. In particular, it:

- does not claim that the Coordinator received or persisted a Mutator outcome;
- does not insert or synthesize `mutation_outcome` execution evidence;
- does not convert the interrupted execution into `completed` or
  `completed_after_ambiguous_mutation`;
- does not resume remaining steps;
- never calls or resends a deployment mutation; and
- always sets `nextTransitionAllowed=false`.

The status contract distinguishes `not_found`, `inflight`,
`resolution_claimed`, `readback_inconclusive`, `terminal_receipt`, and
`final_resolution`; the embedded outcome carries `target_confirmed` or
`manual_review_required`. A terminal normal receipt and a final resolution
receipt cannot coexist. Status is D1-only and reports that Source Verifier,
Reader, Mutator, execution retry, and mutation resend were not called by the
status request itself.

After either final resolution classification, the original operation is
absorbing. Even `target_confirmed` is only incident resolution evidence.
Continuing, rolling back, or advancing requires a newly observed prior state,
a new source proof, and a newly signed operation under the normal transition
policy. `manual_review_required` can never be cleared by replaying or editing
the old operation.

## Resolver Algorithm

The bounded flow is:

1. Validate strict input shape, dedicated owner recovery signature, Resolver
   Version Metadata identity, Reader authority, fresh source proof,
   execution-disabled evidence, completed quiescence, and lease.
2. Read a consistent D1 snapshot and rebuild the exact journal-head digest.
3. Atomically claim the signed generation. Reconcile uncertain claim writes by
   exact digest readback only.
4. Call the Reader for the interrupted step's exact target artifact.
5. Append observation 1, wait the protocol-pinned stability interval, revalidate lease
   and proof lifetime, then call the Reader again.
6. Append observation 2 and classify both canonical states.
7. Create `target_confirmed`, `manual_review_required`, or the non-final
   `readback_inconclusive` attempt receipt. Reconcile uncertain receipt writes
   by exact digest readback only.
8. Return the persisted resolution receipt. Never continue to another step.

At no point does the Resolver possess a mutation capability. All automatic
retry counters remain zero.

## Current Local Implementation Evidence And Gaps

The current worktree provides these local foundations:

- `tools/container_runtime_json_compatibility_deployment_resolution.mjs`
  defines resolver identity, request, Ed25519 approval, and independent
  resolution-receipt v1 validators;
- `tools/container_runtime_json_compatibility_deployment_transition.mjs`
  adds recovery-specific source-authentication and target-readback validation
  without restoring mutation authority;
- transition D1 migration 0003 defines append-preserved claims, observations,
  and outcomes, final-outcome uniqueness, generation/lease/journal guards,
  normal-event and normal-receipt fences, and update/delete rejection; and
- `services/container-runtime-json-compatibility-deployment-resolution`
  provides the D1 snapshot/claim/observation/finalization repository, an inert
  default entrypoint, Resolver and D1-only status implementations, credential-
  free default-off local/staging profiles, one Reader binding, one D1 binding,
  and focused configuration tests.

Focused verification on 2026-08-06 passes four Bun protocol tests with seventeen
expectations. Generated-type drift and TypeScript checks pass. Fourteen Node
Worker/configuration tests pass with an explicit Workerd-test exclusion. They
include 20 concurrent injected-repository attempts with one claim, two reads,
one receipt, terminal replay, N+1 continuation after an inconclusive attempt,
journaled-outcome reconstruction, final-write response-loss reconciliation,
D1-only status, wrong Resolver version or substituted fresh proof rejection
before repository or Reader access, and rejection of an unbound Reader response
identity before observation persistence, all forbidden capability names, and
contradictory/stale drain evidence before D1 or Reader access. The dedicated
Workerd/D1 repository suite passes four tests covering 20 concurrent claims,
post-outcome and malformed target-only checkpoints, operation-digest replay
binding, zero/one-observation finalization rejection, stable/manual/inconclusive
classification, duplicate request IDs, mixed drift, observation spacing,
execution-event/normal-receipt fencing, update/delete guards, and
`INSERT OR REPLACE` rejection with recursive triggers disabled. Aggregate
package tests pass without running the runtime suite twice.
Root `check`/`build:all` scripts and the focused GitHub Actions workflow include
the Resolver contract, generated types, typecheck, tests, and both Wrangler
dry-runs. Both dry-runs are 336.81 KiB upload / 54.04 KiB gzip with one D1
binding, one Reader binding, Version Metadata, and all three gates false.
The complete repository `bun run check` also passes with exit code 0 in
1,462.3 seconds, including all configured frontend, Worker/Workerd,
supply-chain, D1, Rust workspace, and wasm32 gates. The local Workerd runtime
uses the newest date supported by its pinned binary, `2026-07-15`, while the
tracked deploy profiles use `2026-08-06`; exact-date parity remains an explicit
toolchain gate before remote promotion.

The current local v1 recovery request binds the journal head, generation,
Resolver, execution Reader authority, exact fresh source-proof digest and
verification time, structured execution-disabled evidence digest, quiescence
boundary, the evidence-derived interval, and a 45-second claim lease. The
evidence self-binds the Coordinator identity/configuration, caller topology,
`executionEnabled=false`, maximum admitted request lifetime, propagation and
clock-skew allowances, their exact sum of at least 30 seconds, and observation
time. The Resolver rejects a stale, future, contradictory, or authority-drifting
attachment before D1. The signer refuses a claim unless the complete lease fits
inside both proof and owner-authorization windows. Both Resolver and Reader
reject a valid but substituted fresh proof before D1, credential, or network
access. These are locally supplied structured inputs, not independent remote
proof that every admitted execution drained; the collector, repeated remote
readback, and measured maximum values remain mandatory before staging.

The generic authorization ceiling is 600 seconds, but v1 also caps expiry at
the fresh proof's derived 60-second lifetime. A claim requires 45 lease seconds
plus a five-second clock-skew margin to remain, so its effective usable window
is intentionally much shorter. These constants are contract inputs under
test, not remotely measured Cloudflare timing evidence. Changing them changes
the candidate protocol/version and requires new tests, deployment readback,
and owner authorization.

## Required Test Matrix

Local Node and real Workerd/D1 tests must prove at least:

- 20 concurrent identical requests create exactly one claim and one terminal
  resolution receipt; Mutator and Source Verifier bindings are absent and
  their call/property-access counts remain zero;
- normal receipt versus resolution claim, execution event versus claim, and
  two resolver generations linearize without dual terminal state;
- execution-enabled, incomplete drain, stale disable evidence, drift during
  drain, insufficient maximum-lifetime policy, and premature claim all fail
  before D1 claim or Reader access;
- a claim crash allows only a newly signed generation after lease expiry, and
  the old generation can never append observations or a receipt;
- observations from different generations cannot be combined;
- two stable target observations produce only an independent resolution
  receipt, leave the normal receipt absent, and set
  `nextTransitionAllowed=false`;
- a stable source, intermediate, or other same non-target state produces
  `manual_review_required`; mixed or changing states remain
  `readback_inconclusive` under the closed reason-code policy;
- a missing Coordinator-side Mutator outcome is recorded as missing and never
  fabricated;
- claim, observation, and receipt write-ack loss are recovered only by exact
  digest readback; Reader response loss never invents an observation and never
  causes mutation resend;
- wrong Resolver version, Reader version/service/credential identity, Source
  Verifier identity, operation, journal head, generation, authorization domain,
  or N/N-1 schema fails closed at the earliest boundary;
- stale source proof, expired authorization, expired lease, duplicate request
  ID, insufficient observation spacing, and observation after lease fail;
- status sees a consistent complete pre-state or post-state and performs no
  downstream call;
- every resolution table rejects update/delete and terminal receipt types are
  mutually exclusive; and
- tracked Wrangler config has no route, token, Mutator binding, or Source
  Verifier binding, all gates are false, and dry-run output preserves that
  capability inventory.

The staging campaign must repeat concurrency, response-loss, wrong-version,
N/N-1, gate-disable, configuration-propagation, maximum-lifetime, drain,
credential-rotation, D1 ambiguity, and locked-receipt readback tests against
the exact deployed versions. Local mocks and Workerd cannot establish those
remote properties.

## Production Runbook And Remaining NO-GO Gates

Before the first resolver claim in isolated staging:

1. Complete and review the remaining local Resolver gates: implement the
   independent drain-evidence collector/readback path, freeze measured
   maximum-lifetime inputs, extend claim/observation response-loss and
   multi-generation fault injection, and pass the complete local test matrix.
2. Provision and independently read back the exact remote transition D1 schema
   and zero-row starting state.
3. Deploy final private Resolver and Reader versions with gates false. Prove
   exact Version Metadata, exports, D1 and Reader bindings, public-route
   absence, and the physical absence of Mutator, Source Verifier, and token
   capabilities.
4. Complete the owner recovery-key issuance, two-person signing, custody,
   revocation, and audit ceremony. Prove the independent fresh source-proof
   production and delivery path.
5. Disable execution, independently read back the exact Coordinator state and
   account-wide caller topology, run the audited drain, and repeat the readback
   before signing recovery authorization.
6. Run the remote concurrency, response-loss, crash, wrong-version, generation,
   lease, D1, drift, drain, and credential-rotation campaigns.
7. Publish resolution receipts and raw evidence to the locked archive and
   independently read back their exact digests, signatures, retention, and
   revocation state.
8. Obtain independent security, SRE, release, rollback, and incident-response
   approval before any four-transition campaign or traffic change.

The cited tests, local Workerd results, Wrangler dry-runs, and Resolver
worktree are local implementation evidence; they do not establish a complete
production Resolver. No secret was read and no Cloudflare API, remote D1, R2,
route, deployment, traffic, or Go/VPS state was accessed or changed. These
documents are not remote Cloudflare proof. Go/VPS remains authoritative and
production remains **NO-GO**.
