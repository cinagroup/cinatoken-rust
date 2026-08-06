# JSON Compatibility Deployment Transition Coordinator

Status: local protocol, private Coordinator, and physically separate Reader
and Mutator complete through 2026-08-06. The quiesced Reader-only resolver now
has a signed local v1 protocol, migration, private Worker, D1 repository,
Resolver/status core, focused Node and Workerd/D1 tests, root scripts, and CI
wiring. Signed structured drain evidence and local hardening are implemented;
independent remote collection, measured maximum-lifetime values, and runtime
fault evidence are incomplete. No Cloudflare credential, upload, deployment, remote readback,
Durable Object mutation, Container request, traffic change, or Go/VPS cutover
was performed.

## Purpose

The coordinator turns the four frozen state-plan v2 transitions into one
fail-closed execution protocol. It is separate from Operator phase approval:
a valid phase approval cannot authorize a Worker deployment mutation.

The current implementation is
`tools/container_runtime_json_compatibility_deployment_transition.mjs`. It has
no default network client, environment lookup, credential access, sleep,
filesystem write, or Cloudflare SDK. Every source verifier, readback, mutation,
clock, reservation, append, and finalization capability must be injected.

This is the intended production layering:

```text
owner approval
  -> transition coordinator
     -> private Reader Service Binding, read credential only
     -> private Mutator Service Binding, write credential + independent D1
     -> append-only D1 transition journal
     -> locked receipt archive

independent owner recovery approval + fresh source proof
  -> quiesced private Resolution Worker
     -> the same transition D1
     -> private Reader Service Binding only
```

The existing Controller deployment gateway supplies the reference leaf
semantics: reserve before send, one mutation, bounded response evidence,
`accepted | rejected | ambiguous`, no automatic retry, and status-only
readback after uncertainty. Its Controller-specific command, routes, tables,
and incomplete config readback are not reused as the coordinator protocol.

## Authorization

New authorization requires both current documents:

- campaign Plan v5/schema 4; and
- deployment state-plan v2/schema 2.

The coordinator validates the complete plans, their canonical digests, the
Plan v5 deployment-state binding, and all seven execution artifacts. It then
selects exactly one transition already present in state-plan v2. Historical
Plan or state-plan formats cannot authorize a new transition.

The dedicated Ed25519 subject binds:

- the full authorized request digest;
- operation ID digest;
- Plan v5 contract, schema, and digest;
- state-plan v2 contract, schema, and digest;
- transition ordinal, ID, source state, target state, and complete ordered
  steps;
- prior-state identity, entry time, and evidence digest;
- account identity digest;
- source manifest, source signature envelope, immutable source archive,
  18-artifact inventory readback, and account binding inventory digests; and
- issue, not-before, and expiry times.

The signer key is the Plan-pinned approval KID/SPKI root, but the transition
approval uses its own audience, subject/envelope contracts, and signature
domain. Cross-protocol phase approval substitution fails before any injected
dependency is called. The approval lifetime and minimum remaining lifetime
remain bounded by Plan v5 policy. The `statusOnly -> dark` signer and executor
both enforce the exact 86,400-second hold.

This execution authorization cannot authorize inflight resolution. Resolution
requires a separately signed Ed25519 owner recovery authorization with its own
domain and bounded lease. It binds the immutable original operation, exact D1
journal head and generation, final Resolver and Reader identities, a fresh
source-proof digest, and independently read execution-disabled and quiescence
evidence. The Resolver receives the fresh proof as input; it has no Source
Verifier binding.

## Step Protocol

Each frozen step executes in this order:

1. Read the exact source artifact twice through the authenticated readback
   dependency.
2. Require different request IDs, one stable authentication identity, at least
   five seconds between observations, and one semantic remote-state digest.
3. Verify account, service, entrypoint, version, canonical config digest,
   deployment state, gates, private-only flags, and empty route-set digest.
   Binding, route, secret-name, and Durable Object migration set digests are
   explicit expected-state fields and must match both observations. The
   canonical config digest separately binds the exact frozen configuration.
4. Build a mutation intent that binds the authorized request, transition and
   step ordinals, exact service, source/target artifacts, target version/config,
   and the just-observed source-state digest.
5. Append the intent before invoking `mutateOnce`.
6. Recheck approval expiry immediately before the one mutation call.
7. Record the bounded mutation outcome. A rejected outcome stops. An ambiguous
   outcome never resends and may advance only after exact target proof.
8. Read the exact target artifact twice under the same independent stability
   rules before advancing to the next service.

The four orders remain:

```text
dark -> statusOnly      Invoker, Operator, Runner, Caller
statusOnly -> execution Controller, Executor, PermitIssuer, Invoker,
                        Operator, Runner, Caller
execution -> statusOnly Caller, Runner, Operator, Invoker, PermitIssuer,
                        Executor, Controller
statusOnly -> dark      Caller, Runner, Operator, Invoker after 86,400 seconds
```

Direct dark-to-execution, direct execution-to-dark, automatic transition, and
automatic mutation retry remain impossible through this API.

## Journal And Receipt

The injected journal must implement three create-only boundaries:

- `reserve`: `reserved | exact_replay | inflight | conflict`;
- `append`: only `appended` allows execution to continue; and
- `finalize`: only `created` or byte-identical `exact_replay` returns a receipt.

An exact terminal replay returns the archived receipt without source
authentication, readback, or mutation. Inflight, conflict, append ambiguity,
and archive ambiguity raise an explicit uncertain error and never call a
second mutation.

The receipt binds authorization, both plan digests, source authentication,
every source/target observation, every persisted intent, every mutation
outcome, mutation/readback counts, zero automatic retries, stop reason, and
`nextTransitionAllowed`. Step receipts form a predecessor-linked SHA-256 chain;
the terminal receipt binds the chain head and its own canonical digest.

Stopped receipts set `nextTransitionAllowed=false`. Only a fully completed
transition sets it true. This boolean is evidence, not authority for a later
transition; the next operation still needs a fresh dedicated approval and a
new prior-state proof.

## Quiesced Reader-Only Resolution

An inflight operation is never passed back to `executeTransition`. Recovery is
performed by an independent private Resolver Worker only after normal
execution is disabled, that exact state and the account-wide caller topology
are independently read back, and the policy-pinned maximum request lifetime
plus propagation and clock-skew allowance has drained. D1 claim fencing alone
cannot cancel an executor that already persisted `mutation_intent` and is
about to call the Mutator, so this quiescence ceremony is mandatory.

The Resolver's physical capability surface is limited to the transition D1,
Version Metadata, and one Reader Service Binding. It has no Mutator binding,
no Source Verifier binding, no Cloudflare token, no public route, and no normal
execution method. A dedicated Ed25519 recovery authorization binds:

- the operation and immutable execution-authority digests;
- the exact event count, journal-head ordinal/digest, and expected generation;
- Resolver and Reader service, version, capability, credential, and identity
  digests;
- the fresh source proof and approved Source Verifier identity;
- execution-disabled evidence, caller topology, drain inputs, and
  `quiescenceSatisfiedAt`; and
- claim not-before time, stability interval, and a lease bounded by both the
  authorization and source-proof expiry.

One atomic append-only D1 claim elects a generation against the signed journal
head. That generation appends exactly two independently identified target
observations separated by the signed stability interval, then may create one
independently typed resolution receipt. Claim, observation, and receipt write
response loss is handled by exact digest readback only. A lost Reader response
is never invented or automatically retried; a later attempt requires a fresh
source proof and newly signed generation after lease expiry.

The Resolver never appends a normal `mutation_outcome`, never fabricates a
normal transition receipt, never continues remaining steps, and never resends
mutation. A final resolution receipt is either `target_confirmed` or
`manual_review_required`; both set `mutationResent=false` and
`nextTransitionAllowed=false`. Ambiguous or unstable reads may create only a
non-final `readback_inconclusive` attempt receipt and require a freshly signed
generation. A final resolution makes the old operation absorbing. Manual
review, rollback, continuation, or another transition can proceed only through
newly observed prior state and a newly signed operation.

The complete authorization, D1 state machine, test matrix, remote ceremony,
and evidence boundary are in
`docs/container-runtime-json-compatibility-deployment-resolution.md`.

## Local Verification

Run:

```text
bun run check:container-runtime:json-compatibility-deployment-transition
```

The current focused gate passes 14 tests with 157 expectations. Coverage
includes:

- dedicated Plan v5/state-plan v2 authorization and phase-approval rejection;
- all `4/7/7/4` step orders and target version/config bindings;
- the exact 86,400-second closure boundary;
- source authentication rejection;
- source drift and target instability;
- distinct request IDs, five-second stability, and approval recheck;
- accepted, rejected, and response-ambiguous mutation outcomes;
- one mutation per step and zero automatic retries;
- persist-before-send ordering;
- exact terminal replay, inflight refusal, journal conflict, and archive
  ambiguity; and
- rejection of a fully resealed receipt whose mutation intent is detached from
  its frozen step; and
- poisoned global `fetch`, proving no implicit network path.

These tests use generated Ed25519 keys, synthetic current plans validated by
the production validators, and injected fake dependencies. They are not remote
Cloudflare evidence.

The complete repository `bun run check` also passed with exit code 0 in
1,341.7 seconds on 2026-08-05. That aggregate run covered the configured
frontend, Worker/workerd, supply-chain, Rust workspace, and wasm32 gates,
including this focused transition suite. It remains local evidence.

Focused 2026-08-06 Resolver verification separately passes four Bun protocol
tests with seventeen expectations, fourteen Node Worker/config tests, and four
dedicated Workerd/D1 repository tests. Generated types, TypeScript, aggregate package
tests, and both Wrangler dry-runs pass. The tests include 20-way claim
concurrency in both repository modes, terminal-write response-loss replay with
no extra Reader call, D1-only status, and early rejection of wrong Resolver
versions, forbidden capabilities, stale/contradictory drain evidence, and
substituted fresh proofs. An unbound Reader response identity is also rejected
before observation persistence. Real D1 coverage includes malformed journal
checkpoints, operation-digest replay binding, zero/one-observation rejection,
classification parity, append identity ledgers, and `INSERT OR REPLACE`
rejection. Root scripts and focused CI include the new contract and Worker.
The complete repository `bun run check` passes with exit code 0 in 1,462.3
seconds after the hardened Resolver path was added.

## Remaining Production Gates

The coordinator closes the missing local command, approval, stable-readback,
mutation-intent, and terminal-receipt contracts. It does not close the remote
transition gate. Before staging can execute:

1. Provision and independently read back the two remote D1 databases and their
   exact immutable migrations; local Workerd D1 is not remote evidence.
2. Deploy the physically separate Reader, Mutator, Source Verifier,
   Coordinator, and Reader-only Resolver final candidate versions, then bind
   those exact version IDs into new owner execution and recovery authorities.
3. Complete C0/C3 remote inventory derivation for version, config, entrypoint,
   bindings, route absence, gates, secret names without values, and Durable
   Object migrations for all 18 artifacts.
4. Prove account-wide caller topology and real distinct least-privilege Reader
   and Mutator credential issuance, custody, verification, and revocation.
5. Complete the remaining independent Resolver gates: independent remote
   drain-evidence collection/re-read, audited maximum-lifetime measurement,
   wider claim/observation and multi-generation fault injection, and
   compatibility-date parity. The local fresh-proof-bound Reader-only Worker,
   structured evidence contract, and append-only migration already exist.
6. Bind the deployed coordinator version and source release identity, publish
   the terminal receipt to a locked archive, and independently read it back.
7. Run crash injection at every reservation, append, send, response, readback,
   claim, observation, seal, and archive boundary plus concurrent resolver,
   response-loss, wrong-version, generation, lease, drain, drift, concurrent
   operator, and N/N-1 faults.

All 18 versions must still be uploaded dark and independently read back before
any transition. The account binding inventory, topology/context collection,
real four-phase campaign, wider billing/provider/storage/SLO/security/privacy
matrix, Go/VPS drain, and production cutover remain open. Go/VPS remains
authoritative and production remains **NO-GO**.

## Private Worker And D1 Boundary (2026-08-05)

This section supersedes the earlier missing-private-Worker and missing-local-D1
items. It does not supersede any remote deployment blocker.

`services/container-runtime-json-compatibility-deployment-transition` now
hosts the protocol behind a named TypeScript `WorkerEntrypoint`. The inert
default export has no `fetch`; local and staging configs have no route, disable
Workers.dev and preview URLs, contain no credentials, and keep the master,
execution, and status gates false. Generated Wrangler types, Version Metadata,
one D1 binding, and separate source-verifier, deployment-readback, and
deployment-mutation Service Bindings define the complete local capability
surface.

Migration 0001 provides create-only operations, ordered evidence, and one
terminal receipt. Migration 0002 atomically stores the exact four-service
execution authority and enforces distinct Reader/Mutator service, identity,
and credential digests. D1 database time, unique operation/authorization/receipt
digests, canonical body limits, terminal-event ordering, source-authentication
prerequisite, foreign keys, and update/delete guards are enforced in SQL. A
`first-primary` session reserves the operation before any downstream call.
Exact terminal replay is side-effect free; an existing operation without a
receipt is inflight and is never re-executed.

The named status RPC revalidates the signed Plan/state-plan invocation, derives
the operation digest, and reads only D1. Its v3 shape returns `not_found`,
`inflight`, `terminal`, or `resolved`, validating either a normal terminal
receipt or the separate resolution receipt. It neither calls the source
verifier, Reader, nor Mutator. The independent Resolver does not extend this
Coordinator's capability surface and does not reuse the status RPC as recovery
authority.

Real workerd coverage applies both migrations and races four named RPCs. One
operation wins, the others fail inflight, and the completed dark-to-status
transition produces one source authentication, four mutations, 16 reads, 25
events, one authority row, and one receipt. Replay and status add zero
downstream calls. Node
tests also lock default-off/private/credential-free config and all immutable
triggers; both Wrangler configs build in dry-run mode.

The detailed RPC, schema, rollout order, and evidence boundary are in
`docs/container-runtime-json-compatibility-deployment-transition-worker.md`.
The physically separate all-seven-service Reader, Mutator, and fresh-proof-
bound Resolver now exist locally. Still missing are independent remote drain
evidence collection and measured policy values, wider fault and
multi-generation tests, compatibility-date parity, plus non-placeholder remote
D1 apply/readback, real credential and
recovery-signing ceremonies, final Worker deployment/readback, complete C0/C3
inventory derivation, locked archive, remote account caller inventory,
all-18-version dark upload/readback, and the concurrency/response-loss/wrong-
version/drain campaign. No remote operation occurred. The local foundation is
implementation evidence, not remote Cloudflare proof. Go/VPS remains authoritative
and production remains **NO-GO**. See
`docs/container-runtime-json-compatibility-deployment-leaves.md` and
`docs/container-runtime-json-compatibility-deployment-resolution.md`.
