# Private Deployment Transition Worker

Date: 2026-08-05; D0 split and resolution design updated 2026-08-06

Status: Coordinator implementation complete locally; the independent
quiesced Reader-only Resolver now has a signed local v1 protocol, migration,
private Worker, D1 repository, Resolver/status core, focused Node and
Workerd/D1 tests, root scripts, and CI wiring. Signed structured drain evidence
and local hardening are implemented; independent remote collection, measured
maximum-lifetime values, and runtime evidence are still incomplete. Remote
staging and production remain **NO-GO**.

## Purpose And Boundary

`services/container-runtime-json-compatibility-deployment-transition` turns the
credential-free transition protocol into a private Cloudflare Worker control
plane. It owns authorization validation, transition ordering, D1
linearization, Service Binding calls, stable-read timing, terminal receipt
storage, and read-only status. It does not own Cloudflare API credentials,
construct raw Cloudflare REST requests, expose HTTP, select arbitrary
services, or retry a deployment mutation.

The intended split follows the cinaVibeSDK control-plane pattern:

```text
approved Plan v5 + state-plan v2 + transition envelope
  -> JsonCompatibilityDeploymentTransitionEntrypoint (TypeScript)
     -> D1 append-only operation journal
     -> JSON_COMPATIBILITY_SOURCE_VERIFIER Service Binding
     -> JSON_COMPATIBILITY_DEPLOYMENT_READBACK Service Binding
        -> read-only Cloudflare API credential
     -> JSON_COMPATIBILITY_DEPLOYMENT_MUTATION Service Binding
        -> mutation-only Cloudflare API credential + independent D1
  -> canonical terminal receipt

Rust remains in the Linux Container data/compute plane.
```

Inflight resolution is intentionally outside this Worker:

```text
owner recovery authorization + fresh source proof
  -> JsonCompatibilityDeploymentTransitionResolutionEntrypoint
     -> transition D1
     -> Deployment Reader Service Binding only
```

Only the named `JsonCompatibilityDeploymentTransitionEntrypoint` exports
`executeTransition` and `getTransitionStatus`. The default Worker entrypoint is
inert. Both tracked configs set `workers_dev=false`, `preview_urls=false`,
declare no route, contain no credential variable, and leave the master,
execution, and status gates false.

## RPC Contracts

Both methods accept one strict object with exactly `campaignPlan`, `statePlan`,
and `authorizedTransition`. Canonical input is bounded to 1 MiB. The production
validators require current Plan v5/schema 4, state-plan v2/schema 2, and the
dedicated Ed25519 transition approval before a Service Binding is called.

`executeTransition`:

1. Requires staging plus all master/execution gates.
2. Pins the exact signed Coordinator, Source Verifier, Reader, and Mutator
   authorities, including Version Metadata, service, entrypoint, capability,
   identity, and distinct credential digests, into the reserved operation.
3. Reserves the exact operation in a `first-primary` D1 session.
4. Authenticates source evidence once through the verifier binding.
5. For each frozen step, performs two source reads, one persisted intent, at
   most one mutation, and two target reads.
6. Uses the protocol's five-second stability minimum plus one second of clock
   granularity margin before each second read.
7. Stores one canonical completed or stopped receipt.

`getTransitionStatus`:

1. Requires staging plus master/status gates, but not the execution gate.
2. Revalidates the complete signed invocation and derives the exact operation
   digest rather than trusting an operator-supplied lookup key.
3. Reads only D1 and validates any terminal receipt through the production
   receipt validator.
4. Returns `not_found`, `inflight`, `terminal`, or `resolved` with event
   counts, mutation evidence counts, coordinator identity, an optional
   independent resolution receipt, and a canonical status digest.
5. Proves in its contract that source verification, Reader calls, Mutator
   calls, and execution retry were not performed.

Status is currently visibility and terminal-receipt recovery. It deliberately
does not infer or seal the outcome of an inflight operation. The separately
specified Resolver does not add a recovery method to this entrypoint and does
not reuse execution or status authorization.

## Independent Resolution Boundary

The local shell at
`services/container-runtime-json-compatibility-deployment-resolution` is
physically Reader-only. Its environment exposes only Version Metadata, the
transition D1 binding, and the exact deployment Reader Service Binding.
It must not contain a Mutator binding, Source Verifier binding, Cloudflare API
token or token secret name, HTTP route, `fetch` handler, or transition
execution method.

The Resolver accepts a dedicated Ed25519 owner recovery authorization and a
fresh source proof as request inputs. It verifies the fresh proof locally; it
cannot fetch or refresh the proof because it has no Source Verifier binding.
The local recovery signature binds the original operation, immutable
authority, exact journal head, generation, Resolver and Reader identities,
the exact fresh source-proof digest, structured execution-disabled evidence
digest, evidence-derived quiescence interval and boundary, and bounded lease.
The evidence attachment self-binds caller topology, Coordinator configuration,
`executionEnabled=false`, maximum admitted request lifetime, propagation and
clock-skew allowances, their exact sum, and observation time. Independent
remote collection/re-read and measured policy values remain mandatory before
staging use.

Before a claim can be signed, operators must disable the Coordinator execution
gate, independently read back its exact version/configuration and caller
topology, wait longer than the audited maximum lifetime of every already
admitted execution plus propagation and clock-skew allowance, and repeat the
readback. This drain is required because a D1 claim cannot stop an old request
that already appended `mutation_intent` and is about to invoke the separate
Mutator.

The Resolver appends a generation claim, two stable target observations, and
one independent resolution receipt. It never writes a normal execution event
or normal receipt, never synthesizes a missing Mutator outcome, never resends
mutation, and never resumes later steps. Both final `target_confirmed` and
`manual_review_required` resolution receipts set
`nextTransitionAllowed=false`; a non-final `readback_inconclusive` attempt also
grants no retry authority. Any subsequent attempt or action requires the
applicable fresh proof, new generation, prior-state observation, and owner
signature.

The full state machine is in
`docs/container-runtime-json-compatibility-deployment-resolution.md`.

## D1 Journal

Migrations `0001_json_compatibility_deployment_transition.sql` and
`0002_json_compatibility_deployment_transition_authorities.sql` create four
append-preserved tables:

| Table | Authority | Important constraints |
| --- | --- | --- |
| operations | one reservation per operation ID | unique operation and authorized-request digests; Plan/state/transition and deployed coordinator/adapter identities |
| authorities | one exact authority per operation | full canonical authority plus distinct Reader/Mutator service, version, identity, and credential columns |
| events | ordered evidence | operation-local ordinal and digest uniqueness; bounded canonical JSON; source/readback/intent/outcome kinds only |
| receipts | one terminal seal | one operation, one unique receipt digest, completed or stopped only |

D1 `unixepoch()` supplies every stored time. Triggers reject caller-controlled
times, events after a terminal receipt, a receipt without source-authentication
evidence, and every update or delete. Foreign keys prevent operation removal.
Canonical operation, event, and receipt bodies are bounded to 8 KiB, 128 KiB,
and 512 KiB respectively.

Reservation semantics are fail closed:

- first exact insert: `reserved`;
- byte- and identity-exact terminal row: `exact_replay`;
- exact operation without a receipt: `inflight`;
- reused identity with drift: `conflict`;
- unreadable outcome after a write: explicit unavailable/unknown error.

An exact replay returns the persisted receipt without verifier, readback, or
mutation calls. D1 is the operation linearization authority, not a claim of a
distributed exactly-once Cloudflare deployment.

Local migration 0003 adds immutable resolution state rather than changing 0001
or 0002. Separate create-only claim, target-observation, and resolution-outcome
tables bind each attempt to one signed journal head and generation. One
conditional `INSERT ... SELECT` plus exact readback prevents concurrent election, and SQL
fences reject later normal execution events or a normal receipt after a claim.
Normal and resolution receipts are mutually exclusive. Every new table rejects
update/delete; append-preserved identity ledgers also block SQLite
`INSERT OR REPLACE` recreation when recursive triggers are disabled. Lost write
acknowledgements are reconciled only by exact digest readback.

## Local Acceptance

Run:

```text
bun run check:container-runtime:json-compatibility-deployment-transition
bun run check:container-runtime:json-compatibility-deployment-readback
bun run check:container-runtime:json-compatibility-deployment-mutation
bun run check:container-runtime:json-compatibility-deployment-transition-worker
bun run check:container-runtime:json-compatibility-deployment-resolution
```

The first command validates the current pure protocol with 14 tests and 157
expectations. The Worker command verifies generated Wrangler types,
TypeScript, private/default-off config, immutable migration shape, local and
staging dry-run bundles, Node canonical/config tests, and real workerd named
RPC tests backed by D1.

The runtime test applies both actual migrations, races four identical named RPC
requests, admits one operation, rejects the other three as inflight, and
observes one source-authentication call, four mutation calls, 16 readback
calls, 25 journal events, one authority row, and one terminal receipt for
`dark -> statusOnly`. Exact replay and status then add no downstream call. It
also proves all four tables reject update/delete and that a disabled gate
reaches neither D1 nor a Service Binding.

The current local and staging transition dry-runs are 294.87 KiB upload /
48.48 KiB gzip with all three tracked gates false.

After the real source-verifier integration, the complete repository
`bun run check` passed again with exit code 0 in 1,452.7 seconds on
2026-08-05. This supersedes only the local root-gate timing below; it does not
add remote evidence.

The complete repository `bun run check` passed with exit code 0 in 1,310.7
seconds on 2026-08-05 after this Worker was added to the root graph. That run
covered the configured frontend, Workers/workerd, supply-chain contracts,
Rust workspace tests, and wasm32 checks. It remains local evidence.

This is local Workerd/D1/R2 and Wrangler dry-run evidence. The integrated
runtime now executes the actual private source-verifier Worker through a
counting Service Binding proxy and shared R2. Reader and Mutator are physically
distinct runtime mock Workers with separate call counters; their production
packages have independent focused gates. No remote D1/R2 database, external
WORM archive, managed signer, Service
Binding, Worker version, Cloudflare API, credential, route, traffic, or Go/VPS
state is tested or changed. See
`docs/container-runtime-json-compatibility-source-verifier.md`.

The Resolver foundation adds four passing Bun protocol tests with seventeen
expectations, fourteen Node Worker/configuration tests, and four dedicated
Workerd/D1 repository tests. Generated-type drift and TypeScript pass. Node
tests race 20 injected-repository calls to one claim/two reads/one receipt,
reconcile final-write response loss without another Reader call, and reject a
wrong Resolver version, forbidden capability, stale/contradictory drain
evidence, or substituted fresh proof before repository or Reader access. They
also reject an unbound Reader response identity before observation persistence.
The Workerd/D1 tests race 20 claims and cover post-outcome and malformed
checkpoints, operation-digest replay binding, zero/one-observation rejection,
classification guards, duplicate/mixed/stable readback pairs, exact replay,
spacing, execution fencing, identity ledgers, and `INSERT OR REPLACE`
rejection. The
aggregate package test is green, both Wrangler dry-runs pass, and root scripts
plus focused CI include the new Worker. Both Resolver dry-runs are 336.81 KiB
upload / 54.04 KiB gzip with one D1 and one Reader binding and all gates false.
The complete repository `bun run check` passes with exit code 0 in 1,462.3
seconds after this hardening.

The signed request now binds the exact fresh source-proof digest and the
canonical structured drain evidence. Independent remote collection/re-read,
measured maximum-lifetime inputs, wider claim/observation response-loss
campaigns, compatibility-date parity, and all remote evidence remain
incomplete.

## Staging Deployment Sequence

Do not deploy this Worker until the Source Verifier, Reader, and Mutator
packages and their remote evidence plan are independently reviewed. Then
execute the following order without skipping or combining stages:

1. Review the implemented private source verifier, then implement its
   independent paginated collector, external-WORM archiver, isolated signer,
   create-once R2 uploader, and remote readback. Pin the approved verifier
   policy plus source-signature, archive, artifact, and account-binding roots.
2. Issue distinct reviewed Reader and Mutator credentials and retain creation,
   permission, custody, verification, and revocation evidence without placing
   secret values in tracked files or command arguments.
3. Create the Coordinator and Mutator staging D1 databases through the
   create-once infrastructure ceremony. Replace placeholders, apply all frozen
   migrations, and independently read back tables, indexes, triggers, foreign
   keys, migration heads, and zero-row state.
4. Deploy final private Verifier, Reader, Mutator, Coordinator, and Reader-only
   Resolver candidate versions. Read back exact Worker version/export/config/
   binding identities, public-route absence, and account-wide caller inventory
   before creating the owner execution and recovery authorities.
5. Upload all 18 dark/status-only/execution versions without activation and
   independently reconstruct state-plan v2 from remote evidence.
6. Complete and locally approve the remaining Resolver gates: implement
   independent drain-evidence collection/re-read, freeze measured policy
   values, extend exact-replay and multi-generation fault campaigns, align the
   Workerd/deploy compatibility date, and pass the complete concurrency/
   response-loss/wrong-version/drain test matrix.
7. Run disabled/status-only tests first. Status must read D1 only; mutation and
   verifier counters must remain zero.
8. Run crash and response-loss injection around reserve, append, send,
   response, each readback, claim, observation, and both receipt seals.
   Concurrent operators and resolvers must yield one admissible authority with
   no dual terminal state and no resolver mutation capability.
9. Disable execution, independently read back the exact Coordinator state and
   account-wide caller topology, wait the audited maximum-lifetime drain,
   repeat the readback, obtain a fresh source proof, and only then sign one
   bounded recovery generation.
10. Deploy and read back the final private Resolver with only D1 and Reader
    bindings. Run the remote wrong-version, response-loss, lease, generation,
    D1, drain, and credential-rotation campaigns, then publish the independent
    resolution receipt and raw evidence to a locked, independently readable
    archive.
11. Only after independent security/SRE/release approval, execute the four
   state transitions and real four-phase compatibility campaign in isolated
   staging. Go/VPS remains authoritative throughout.

## Production Blockers

Production remains **NO-GO** until all of these are remote evidence, not local
claims. The complete D0 sequence is in
`docs/container-runtime-json-compatibility-deployment-leaves.md`.

- deployed source verifier, independent collector/signer/create-once uploader,
  external WORM evidence, and physically separate Reader and Mutator;
- applied and independently read back Coordinator and Mutator D1 schemas;
- exact remote version/config/export/binding/route/secret-name/migration
  inventory for Verifier, Reader, Mutator, Coordinator, and all 18 service
  artifacts;
- account-wide proof that no unreviewed Worker can call a mutation capability;
- implemented and deployed quiesced Reader-only resolution with independent
  owner recovery authorization, fresh source-proof input, physical absence of
  Mutator/Source Verifier/token capabilities, and remote concurrency,
  response-loss, wrong-version, lease, generation, and drain evidence;
- locked receipt/source archive with signature, revocation, retention, and
  independent readback;
- real topology/context collection and four-phase N/N-1 campaign;
- provider, billing, settlement, storage, SLO, capacity/cost, security,
  privacy, rollback, reverse-sync, drain, and traffic-cutover acceptance.

The local Worker closes an implementation gap. It grants no deployment or
traffic authority, and Go/VPS remains the production system of record.
