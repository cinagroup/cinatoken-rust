# JSON Compatibility Deployment Transition Coordinator

Status: local protocol and dependency-injected coordinator complete on
2026-08-05. No Cloudflare credential, upload, deployment, remote readback,
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
     -> private Service Binding
        -> create-once Cloudflare deployment leaf
        -> authenticated readback leaf
     -> append-only D1 transition journal
     -> locked receipt archive
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

## Step Protocol

Each frozen step executes in this order:

1. Read the exact source artifact twice through the authenticated readback
   dependency.
2. Require different request IDs, one stable authentication identity, at least
   five seconds between observations, and one semantic remote-state digest.
3. Verify account, service, entrypoint, version, canonical config digest,
   deployment state, gates, private-only flags, and empty route-set digest.
   Binding, secret-name, and Durable Object migration set digests remain in the
   semantic state and must be stable. The canonical config digest binds their
   exact frozen configuration.
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

## Local Verification

Run:

```text
bun run check:container-runtime:json-compatibility-deployment-transition
```

The current focused gate passes 12 tests with 142 expectations. Coverage
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

## Remaining Production Gates

The coordinator closes the missing local command, approval, stable-readback,
mutation-intent, and terminal-receipt contracts. It does not close the remote
transition gate. Before staging can execute:

1. Implement a private TypeScript Worker coordinator using generated Wrangler
   types and Service Bindings. Do not add a public route or default execution
   entrypoint.
2. Generalize the create-once leaf to all seven allowlisted services and prove
   the exact Cloudflare request body, annotation, account, target version, and
   at-most-one send.
3. Implement authenticated normalized readback for version, config,
   entrypoint, bindings, route absence, gates, secret presence without values,
   and Durable Object migrations. The upload response is not readback.
4. Add an append-only D1 journal with database time, unique operation/intent
   authority, immutable update/delete guards, step predecessor links, and one
   terminal seal.
5. Add a status-only recovery route for an inflight reservation. It may perform
   authenticated readback and seal a result, but must never call mutation.
6. Bind the deployed coordinator version and source release identity, publish
   the terminal receipt to a locked archive, and independently read it back.
7. Run crash injection at every reservation, append, send, response, readback,
   seal, and archive boundary plus response-loss, drift, concurrent operator,
   and N/N-1 faults.

All 18 versions must still be uploaded dark and independently read back before
any transition. The account binding inventory, topology/context collection,
real four-phase campaign, wider billing/provider/storage/SLO/security/privacy
matrix, Go/VPS drain, and production cutover remain open. Go/VPS remains
authoritative and production remains **NO-GO**.
