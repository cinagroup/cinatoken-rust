# JSON Compatibility Operator Approval v2

Status: local implementation contract. This document does not authorize a
Cloudflare upload, deployment, gate transition, campaign execution, or
production cutover.

## Purpose

The Operator approval is the human-controlled authorization boundary before a
phase request can reach the Invoker Durable Object. Approval v1 signed the
exact campaign and Plan digest, but did not declare which Plan contract and
schema gave that digest its meaning. Approval v2 closes that protocol-level
ambiguity without changing Plan v5 itself.

The current authority chain is:

```text
offline owner approval signer
  -> authorized Operator request
  -> Caller Worker
  -> Runner Worker
  -> Operator Worker approval verifier
  -> Invoker Durable Object
  -> PermitIssuer Durable Object
  -> Executor Durable Object
  -> Controller Durable Object
  -> Rust Linux Container shards
```

The Operator must reject an invalid approval before any Invoker RPC. Caller
and Runner remain transport and receipt-validation layers; they do not replace
the Operator's signature and trust-anchor verification.

## Current Contracts

The authorized request wrapper remains v1 because its outer shape is
unchanged. Its `approval` member is now exactly:

```text
subject contract  cinatoken-container-runtime-json-compatibility-operator-phase-approval-subject-v2
subject schema    2
envelope contract cinatoken-container-runtime-json-compatibility-operator-phase-approval-envelope-v2
envelope schema   2
algorithm         Ed25519
signature domain  cinatoken-container-runtime-json-compatibility-operator-phase-approval-v2\n
```

The v2 subject retains every v1 execution binding and adds two required
fields:

```json
{
  "planContract": "cinatoken-container-runtime-json-compatibility-plan-v5",
  "planSchemaVersion": 4,
  "planDigestSha256": "<canonical Plan v5 digest>"
}
```

These values are separate on purpose. `planDigestSha256` identifies one exact
plan document; `planContract` and `planSchemaVersion` define the schema under
which that document is interpreted. All three must match the phase request and
the current Plan v5 contract.

The complete subject also binds environment, issuer, audience, key ID,
Operator version, exact Runner target, campaign ID, phase execution ID,
ordinal, phase ID, request digest, command ID, topology readback digest,
before-context digest, issue time, not-before time, and expiry time. Unknown,
missing, duplicate after parsing, or incorrectly typed members are rejected.

The canonical signature payload is:

```text
UTF8(signature-domain-v2 + canonicalJson(subject-v2))
```

Changing either new Plan field changes both `subjectSha256` and the Ed25519
signature. Recomputing only JSON digests cannot turn a v1 approval, a mixed
v1/v2 envelope, or a wrong-plan v2 approval into a valid current artifact.

## Runtime Verification

The TypeScript Operator Worker performs the following checks before invoking
the named Invoker Service Binding:

1. Parse an exact authorized-request wrapper and exact v2 envelope/subject.
2. Require Plan v5 contract and schema 4 literals in the signed subject.
3. Bind the subject to the exact request, campaign, plan digest, phase,
   topology readback, before-context, Operator version, and Runner identity.
4. Select only the configured current or previous approval key ID.
5. Compare subject, SPKI, and configured trust-anchor digests without an early
   exit on equal-length values.
6. Enforce issue, not-before, maximum lifetime, minimum remaining lifetime,
   clock-skew, and read-only recovery-window rules.
7. Verify Ed25519 over the v2 signature domain with Web Crypto.
8. Preserve the full envelope plus canonical subject/envelope digests in the
   Operator receipt.
9. Stop on every rejection. No Invoker RPC, Durable Object mutation,
   PermitIssuer call, Executor call, or retry is allowed.

Status recovery verifies the same signed approval. It may only query the
existing execution status and remains unable to reconstruct or repeat a lost
execution call.

## Offline Signer

The offline signer is the only supported creator of a current approval. It:

- accepts only a validated Plan v5/schema 4 document;
- validates the exact Operator campaign config digest and pinned Invoker
  version against that plan;
- verifies the signing public key against the plan's frozen SPKI digest;
- reads the private key only from bounded, non-TTY stdin;
- clears the in-memory private-key buffer after use;
- creates a new output file atomically enough for the local ceremony and
  refuses to replace an existing file;
- emits canonical JSON; and
- performs no credential lookup, network request, deployment, or gate change.

Plan v4, v3, and v2 cannot be passed to the signer. Historical validation is a
different capability from new authorization issuance.

## Compatibility Matrix

| Campaign Plan | Approval subject/envelope | Signature domain | Capability |
| --- | --- | --- | --- |
| v5 / schema 4 | v2 / schema 2 | v2 | current local signing and runtime verification |
| v4 / schema 3 | v1 / schema 1 | v1 | historical receipt read only |
| v3 / schema 2 | v1 / schema 1 | v1 | historical receipt read only |
| v2 / schema 1 | v1 / schema 1 | v1 | historical direct receipt read only |

The following combinations fail closed:

- Plan v5 with approval v1;
- historical Plan v4/v3/v2 with approval v2;
- v2 subject in a v1 envelope or v1 subject in a v2 envelope;
- v2 fields with a v1 signature domain, or v1 fields with a v2 domain;
- a Plan v5 digest paired with a different plan contract or schema;
- a valid signature paired with a changed request, Runner, Operator, phase,
  context, topology, time window, or trust anchor; and
- a structurally valid but untrusted public key.

Historical readability does not authorize a new execution. The current signer
and campaign-creation paths remain current-contract only.

## Cloudflare Alignment

The implementation follows the current Workers production guidance:

- Worker-to-Worker traffic uses named Service Bindings rather than public HTTP
  or the Cloudflare REST API;
- the default Worker entrypoint remains inert and has no route;
- approval private keys never enter Worker variables, Wrangler config, argv,
  tracked files, or logs;
- non-secret key IDs and SPKI digests are frozen in versioned configuration;
- all RPC and Web Crypto promises are awaited;
- no request-scoped mutable state is stored at module scope; and
- observability remains enabled on the private Worker configs.

Reference: [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Verification

The local acceptance surface is:

```text
bun run check:container-runtime:json-compatibility-operator
bun run check:container-runtime:json-compatibility-campaign
bun run check:container-runtime:json-compatibility-deployment-states
bun run check:container-runtime:json-compatibility-deployment-transition
bun run check
```

Tests must cover valid current direct and status receipts, v1 downgrade,
mixed-version contracts, wrong Plan metadata, wrong signature domain,
resealed digest-only tampering, wrong Runner/Operator/request bindings,
untrusted keys, invalid time windows, no-RPC rejection, and historical v1
readability.

Current focused results are 133 campaign/source/config tests with 578
expectations, 14 deployment-state tests with 82 expectations, Operator service
checks with 16 Node plus 2 workerd tests, Runner checks with 10 Node plus 2
workerd tests, and Caller checks with 11 Node plus 2 workerd tests. All three
Worker gates include TypeScript and local/staging Wrangler dry-runs. The
complete repository `bun run check` passes with exit code 0 in 1,403.6 seconds.

## Remaining NO-GO Gates

Approval v2 closes only the local Plan-meaning ambiguity. Isolated staging
now has a separate local transition coordinator contract, but still requires
its private Cloudflare mutation/readback leaf, applied immutable D1 journal,
status-only inflight recovery and locked receipt archive. Authenticated
version/config/binding readback, account-wide binding inventory, exact
topology and context collection, source signing and revocation evidence,
immutable archive publication/readback, and the real four-phase campaign.

The transition approval is deliberately not this phase approval. It uses a
separate audience, subject/envelope contracts, and signature domain while
binding the same current Plan trust root. See
`docs/container-runtime-json-compatibility-deployment-transition.md`.

No local test or Wrangler dry-run proves those remote properties. Go/VPS stays
authoritative and production remains **NO-GO** until the complete migration
acceptance matrix passes against the Cloudflare account and `cinatoken.com`.
