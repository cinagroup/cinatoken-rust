# Private Deployment Transition Worker

Date: 2026-08-05

Status: local implementation complete; remote staging and production NO-GO.

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
     -> JSON_COMPATIBILITY_DEPLOYMENT_LEAF Service Binding
        -> authenticated Cloudflare readback or one create-once mutation
  -> canonical terminal receipt

Rust remains in the Linux Container data/compute plane.
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
2. Pins the coordinator Version Metadata ID, profile version, leaf service
   name, and source-verifier service name into the reserved operation.
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
4. Returns `not_found`, `inflight`, or `terminal` with event counts, mutation
   evidence counts, coordinator identity, and a canonical status digest.
5. Proves in its contract that source verification, leaf readback, leaf
   mutation, and execution retry were not performed.

Status is currently visibility and terminal-receipt recovery. It deliberately
does not infer or seal the outcome of an inflight operation. A future
readback-only resolver must be separately authorized, must never invoke
mutation, and must pass the response-loss/crash matrix before staging.

## D1 Journal

Migration `0001_json_compatibility_deployment_transition.sql` creates three
append-preserved tables:

| Table | Authority | Important constraints |
| --- | --- | --- |
| operations | one reservation per operation ID | unique operation and authorized-request digests; Plan/state/transition and deployed coordinator/adapter identities |
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

## Local Acceptance

Run:

```text
bun run check:container-runtime:json-compatibility-deployment-transition
bun run check:container-runtime:json-compatibility-deployment-transition-worker
```

The first command validates the current pure protocol with 13 tests and 147
expectations. The Worker command verifies generated Wrangler types,
TypeScript, private/default-off config, immutable migration shape, local and
staging dry-run bundles, Node canonical/config tests, and real workerd named
RPC tests backed by D1.

The runtime test applies the actual migration, races four identical named RPC
requests, admits one operation, rejects the other three as inflight, and
observes one source-authentication call, four mutation calls, 16 readback
calls, 25 journal events, and one terminal receipt for `dark -> statusOnly`.
Exact replay and status then add no downstream call. It also proves all three
tables reject update/delete and that a disabled gate reaches neither D1 nor a
Service Binding.

The current local and staging transition dry-runs are 242.48 KiB upload /
40.64 KiB gzip with all three tracked gates false.

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
counting Service Binding proxy and shared R2; the deployment leaf remains a
mock. No remote D1/R2 database, external WORM archive, managed signer, Service
Binding, Worker version, Cloudflare API, credential, route, traffic, or Go/VPS
state is tested or changed. See
`docs/container-runtime-json-compatibility-source-verifier.md`.

## Staging Deployment Sequence

Do not deploy this Worker until the leaf and verifier protocols are implemented
and independently reviewed. Then execute the following order without skipping
or combining stages:

1. Review the implemented private source verifier, then implement its
   independent paginated collector, external-WORM archiver, isolated signer,
   create-once R2 uploader, and remote readback. Pin the approved verifier
   policy plus source-signature, archive, artifact, and account-binding roots.
2. Implement an allowlisted all-seven-service leaf. Separate readback from
   mutation capability; enforce account, service, entrypoint, version/config,
   annotation, and create-once operation identity; retain bounded request and
   response evidence; never retry an unknown send.
3. Create the staging D1 database, replace the placeholder database ID, apply
   migration 0001, and independently read back normalized tables, indexes,
   triggers, foreign keys, and zero-row state.
4. Deploy verifier, leaf, and coordinator with no public route and every gate
   false. Read back exact Worker version/export/config/binding identities and
   the account-wide caller inventory.
5. Upload all 18 dark/status-only/execution versions without activation and
   independently reconstruct state-plan v2 from remote evidence.
6. Run disabled/status-only tests first. Status must read D1 only; mutation and
   verifier counters must remain zero.
7. Run crash and response-loss injection around reserve, append, send,
   response, each readback, and final seal. Concurrent operators must yield one
   reservation and at most one mutation per step.
8. Add and verify a separately authorized readback-only inflight resolver, then
   publish the terminal receipt and raw evidence to a locked, independently
   readable archive.
9. Only after independent security/SRE/release approval, execute the four
   state transitions and real four-phase compatibility campaign in isolated
   staging. Go/VPS remains authoritative throughout.

## Production Blockers

Production remains **NO-GO** until all of these are remote evidence, not local
claims:

- deployed source verifier, independent collector/signer/create-once uploader,
  external WORM evidence, and all-seven-service deployment leaf;
- applied and independently read back D1 schema;
- exact remote version/config/export/binding/route/secret-name/migration
  inventory for verifier, leaf, coordinator, and all 18 service artifacts;
- account-wide proof that no unreviewed Worker can call a mutation capability;
- readback-only inflight resolution and complete crash/response-loss matrix;
- locked receipt/source archive with signature, revocation, retention, and
  independent readback;
- real topology/context collection and four-phase N/N-1 campaign;
- provider, billing, settlement, storage, SLO, capacity/cost, security,
  privacy, rollback, reverse-sync, drain, and traffic-cutover acceptance.

The local Worker closes an implementation gap. It grants no deployment or
traffic authority, and Go/VPS remains the production system of record.
