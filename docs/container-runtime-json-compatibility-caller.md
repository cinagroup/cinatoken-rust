# JSON Compatibility Private Caller

Status: local implementation and dry-run verification complete on 2026-08-05.
No Cloudflare upload, deployment, secret operation, remote RPC, Durable Object
mutation, Container request, traffic change, or Go/VPS cutover was performed.

## Purpose

The Caller is the private, plan-bound entry to the isolated four-phase JSON
compatibility campaign. It closes the previous local gap where the named
Runner existed but no exact upstream Worker, version, configuration, gate, or
receipt proved how the Runner was reached.

The complete local call chain is:

```text
Caller -> Runner -> Operator -> Invoker DO -> PermitIssuer DO
       -> Executor DO -> Controller DO -> eight Rust Container shards
```

This follows the cinaVibeSDK ownership model: a thin TypeScript edge/RPC layer
selects an exact stateful authority, Durable Objects own ordering and durable
state, and Rust remains in the Linux Container compute layer. The Caller is
stateless. It does not duplicate the Invoker DO's one-attempt-per-phase or
phase-order authority.

## Worker Boundary

`services/container-runtime-json-compatibility-caller` exports only the named
`JsonCompatibilityCampaignCallerEntrypoint`. Its default `WorkerEntrypoint`
is inert. Both tracked Wrangler configs have no route, set `workers_dev=false`
and `preview_urls=false`, enable full staging observability, bind Version
Metadata, and bind the exact named Runner entrypoint through
`JSON_COMPATIBILITY_RUNNER_SERVICE`.

The two RPC methods are:

- `invokePhase`: requires the execution gate, validates a bounded authorized
  request, calls Runner `invokePhase` exactly once, deeply validates the
  complete nested receipt, and never retries an unknown result.
- `getPhaseStatus`: requires the independent status-read gate, calls Runner
  `getPhaseStatus` exactly once, accepts only a completed read-only recovery,
  and never converts recovery into execution.

The Caller pins the Runner Version Metadata ID and canonical config SHA-256.
It rejects route/binding drift, wrong entrypoint or version, a detached request
or command, malformed/oversized JSON, excessive depth or node count, nested
receipt drift, and non-monotonic timing. Known failures are normalized without
serializing upstream exception text.

## Deployable States

The create-only Caller config preparer emits exactly three profiles:

| State | Execution | Status read | Runner identity |
| --- | --- | --- | --- |
| `dark` | false | false | forbidden and empty |
| `status-only` | false | true | exact version and config digest required |
| `execution` | true | true | exact version and config digest required |

Omitting `--deployment-state` retains the historical execution default for
the preparer only. Tracked local and staging configs remain dark. The preparer
accepts no secret input and writes create-only output.

## Frozen Contracts

Current campaign creation emits Plan v5/schema 4. It binds Controller plus six
private services: Caller, Runner, Operator, Invoker, PermitIssuer, and
Executor. Its deployment-state binding requires state-plan v2/schema 2 and all
seven execution version/config artifacts.

The state plan freezes 18 artifacts:

- Controller, Executor, and PermitIssuer: dark and execution;
- Invoker, Operator, Runner, and Caller: dark, status-only, and execution.

Transition order is fixed:

```text
dark -> statusOnly      Invoker, Operator, Runner, Caller
statusOnly -> execution Controller, Executor, PermitIssuer, Invoker,
                        Operator, Runner, Caller
execution -> statusOnly Caller, Runner, Operator, Invoker, PermitIssuer,
                        Executor, Controller
statusOnly -> dark      Caller, Runner, Operator, Invoker after 86,400 seconds
```

Direct dark-to-execution, direct execution-to-dark, automatic transition, and
execution retry remain forbidden. Plan and inventory validators can read their
historical versions, but both creation CLIs explicitly require current v2
state artifacts.

## Receipt And Source Chain

Plan v5 phase assembly accepts a Caller invocation receipt or completed Caller
status receipt. A bare Runner receipt is rejected. The Caller projection
retains separate digests for:

- the complete raw nested Runner JSON; and
- the Runner's own claimed canonical receipt digest.

These values are intentionally not interchangeable. The projection also binds
Caller version/config, Runner version/config, request payload, named binding,
RPC method, phase identity, timing, and no-retry facts.

Current phase packets and source manifests are v3. Historical Plan v4/v3 uses
Runner-first packet/manifest v2. Plan v2 remains direct-only and cannot
authorize status recovery. Cross-version combinations fail exact-key and
contract validation. Public evidence remains v1 because it binds the strictly
validated source-manifest digest.

| Plan | State plan | Packet / manifest | Entry receipt | New execution |
| --- | --- | --- | --- | --- |
| v5/schema 4 | v2/schema 2 | v3/v3 | Caller | allowed by local contract |
| v4/schema 3 | v1/schema 1 | v2/v2 | Runner | historical read only |
| v3/schema 2 | none | v2/v2 | Runner | historical read only |
| v2/schema 1 | none | v2/v2 direct only | Runner | historical read only |

## Local Verification

The repository gates cover generated Worker types, TypeScript, local and
staging Wrangler dry-runs, Node tests, real workerd named Service Binding RPC,
three-state config generation, current/historical contract pairing, deep
receipt validation, bounded files, create-only writes, and negative drift.

```text
bun run check:container-runtime:json-compatibility-caller
bun run check:container-runtime:json-compatibility-campaign
bun run check:container-runtime:json-compatibility-deployment-states
```

Current results are 133 campaign/source/config tests with 578 expectations,
14 deployment-state tests with 82 expectations, and Caller service checks with
11 Node plus 2 workerd tests. The complete root `bun run check` passed with
exit code 0 in 1,403.6 seconds.

These are local and dry-run gates. They do not prove account-level binding
reachability or a deployed version.

## Remaining NO-GO Gates

Approval subject/envelope v2 is now implemented locally. Plan v5/schema 4 is
part of the signed subject, the signature domain is v2, Plan v5 approval v1 is
rejected, and historical Plan v4/v3/v2 approval v1 remains read only. See
`docs/container-runtime-json-compatibility-operator-approval-v2.md`.

Before isolated staging execution:

1. Implement the fail-closed remote transition executor for only the four
   frozen state transitions, including owner approval, source authentication,
   authenticated remote readback, and immutable transition receipts.
2. Upload all 18 versions dark, then independently read back exact version,
   config, entrypoint, binding target, route absence, gate state, secret
   presence without values, and Durable Object migrations.
3. Produce the complete account binding inventory and prove no unauthorized
   Worker has equivalent reachability.
4. Implement exact topology deployment/readback and independent before/after
   context collection.
5. Add source signing, signer revocation evidence, immutable archive
   publication, retention, and readback.
6. Run the real baseline, mixed, candidate, and rollback campaign plus replay,
   ambiguity, eviction, drift, response-loss, drain, and rollback negatives.
7. Complete the wider provider, billing, storage, SLO/cost, security/privacy,
   owner approval, Go/VPS drain, and production cutover gates.

Until every remote gate passes, all tracked campaign gates stay false,
Go/VPS remains authoritative, and production remains **NO-GO**.
