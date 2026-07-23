# Relay Container Ring Transition Mutation Authorization

Date: 2026-07-23

Status: staging signed-authorization verification and deployment-set readback
contracts implemented locally; the offline verifier deliberately grants no
remote mutation authority, no remote claim authority or mutation runner is
deployed, and production remains **NO-GO**.

## Purpose

The adjacent-ring review contract proves that a proposed `G/N -> G+1/M`
transition is internally consistent. It deliberately returns
`remoteMutationAuthorized=false`. This second contract is the narrow bridge
between that review and a future staging mutation runner.

The signed packet approves exactly the following proposed opening phase. The
offline verifier validates that approval but cannot make it executable:

1. atomically claim one short-lived execution nonce in a remote D1-backed claim
   authority;
2. repeat an authenticated Controller/Edge deployment-set readback;
3. move the Controller service from the reviewed old version to the reviewed
   transition-capable version at 100 percent;
4. prove the Controller post-deployment readback;
5. repeat the Edge deployment-set readback;
6. move the Edge service from the reviewed old version to the reviewed new
   version at 100 percent;
7. prove the Edge post-deployment readback.

It does not authorize version upload, Container image rollout, D1/KV/R2 or
binding changes, secret mutation, deployment deletion, cleanup, generation
rollback, provider calls, customer traffic, Go/VPS shutdown, or production.

## Source-Informed Design

The source pins remain:

- cinaVibeSDK `918e97480ee44e357abe99bf33c27259d6ac7ebd`;
- Go cinatoken `73652508abc5cb09214dde02d51d69d1d1ccc703`.

cinaVibeSDK demonstrates the useful boundary: an edge Worker addresses a
stable Durable Object coordination identity and the DO owns an isolated
Container lifecycle. Its per-session state persists enough identity to rebuild
after an ephemeral Container dies. cinatoken-rust applies that principle to a
stable shard identity and persists operation, lifecycle, recovery, and ring
facts in DO SQLite rather than process memory.

The migration does not copy cinaVibeSDK's process-local health interval or
unbounded deployment retry. A paid relay cannot infer whether a timed-out
mutation failed. Every remote write is therefore single-attempt and an
ambiguous response is classified only by authenticated readback.

The Go source starts background work from a process-level master role. That is
not a distributed deployment lock and cannot prevent two generations or two
operators from writing concurrently. The Cloudflare transition therefore
requires a durable, unique, expiring claim before the first mutation. Go/VPS
retains traffic and scheduler authority throughout this staging phase.

## Contract Stack

```text
transition review manifest
  cinatoken-relay-container-ring-transition-manifest-v1
            |
            | verifier re-runs all seven evidence checks and five approvals
            v
mutation authorization manifest
  cinatoken-relay-container-ring-transition-authorization-manifest-v1
            |
            | four independent authorization approvals
            v
future mutation runner
  atomic claim -> T1 read -> Controller write/read -> Edge read/write/read
```

The authorization trust policy is external to the bundle and cryptographically
distinct from the transition review policy. Its key fingerprints must also be
disjoint from every transition-review key. Security, operations, release, and
rollback use four ordered, distinct Ed25519 keys. The approval domain is:

```text
cinatoken-relay-container-ring-transition-authorization-approval-v1
```

Authorization is staging-only, valid for 60 through 600 seconds, and expires no
later than the transition admission start or transition review expiry.

## Signed Subject

The signed subject binds:

- transition manifest, subject, review-policy, plan, and candidate digests;
- the positive review decision;
- a unique authorization ID and a distinct execution nonce;
- Controller and Edge service names;
- exact reviewed old deployment-set digests and version IDs;
- exact target version IDs and 100-percent target allocation;
- canonical Controller and Edge transition-overlay digests;
- Controller-first order and required post-Controller/pre-Edge readbacks;
- `read-verify-write-read` optimistic concurrency;
- `nativeAtomicCasClaimed=false` and `maxExecutions=1`;
- five canonical evidence artifacts;
- the explicit mutation and non-authority boundary.

The offline output sets `offlineSignedAuthorizationVerified=true` while keeping
`trustedPolicyAnchorVerified=false`, `remoteMutationAuthorized=false`, and
`workerDeploymentMutationAuthorized=false`. It also sets
`runnerTrustedPolicyAnchorRequired=true`, `atomicRemoteClaimRequired=true`,
`authenticatedT1ReadbackRequired=true`, and
`authenticatedPostMutationReadbackRequired=true`. The verifier itself remains
offline and read-only and reports `mutationPerformedByVerifier=false`.

## Evidence Artifacts

All five artifacts are bounded, canonical JSON plus one newline, single-link
regular files at fixed paths below `evidence/`:

| Kind | Required proof |
| --- | --- |
| `deployment-set-readback` | Stable two-sample Cloudflare API readback for Controller and Edge, exact old deployment digests/version IDs, version-detail digests, verified read-credential identity hash, account hash, execution nonce, and transition plan |
| `credential-scope-readback` | Exposed credential revoked; distinct replacement read/deploy credential identities; least-privilege account scope; no token value |
| `operator-ceremony` | At least two distinct live operators, no break-glass, session/recording digests, abort owner, authorization ID, and nonce |
| `single-use-claim-readiness` | D1 unique-claim authority identity, `unclaimed` state, atomic unique insert and TTL required, no pre-authorization claim |
| `rollback-readiness` | Go/VPS traffic and scheduler authority, retained dual-ring Controller drain, previous Edge allowed after partial success, no generation rollback, and forward-repair plans |

The verifier opens and hashes the actual artifact files. It rejects unknown
fields, stale or expired evidence, symlinks, hard links, changing files, byte or
digest drift, shared approval keys, signature replay, unsafe booleans, or any
deployment identity mismatch.

## Deployment-Set Collector

`tools/collect_relay_container_ring_transition_deployment_sets.mjs` is the
read-only source for the first artifact. Its response shape is pinned to the
repository's Wrangler 4.110.0 bundle and embedded Cloudflare SDK 5.2.0:

```text
GET /accounts/{account}/tokens/verify
GET /accounts/{account}/workers/scripts/{service}/deployments
GET /accounts/{account}/workers/scripts/{service}/versions/{active-version}
```

It first verifies the account-owned token ID and status, then reads Controller
and Edge twice, for nine total bounded GET requests. It does not retry. The
verified token ID hash must equal
`CINATOKEN_RING_TRANSITION_READ_TOKEN_ID_SHA256` and later match the signed
credential-scope artifact. The active deployment must contain one reviewed
version at 100 percent. The deployment identity uses canonical service name,
deployment ID, percentage strategy, and sorted version allocation. The complete
version-detail response is separately canonicalized and hashed so version
detail drift fails the before/after comparison. Non-versioned script settings
are not covered by this endpoint and remain a separate runner precondition.
Observation timestamps are taken after each real snapshot completes, not
inferred from the requested sleep, and the collector fails if the measured
interval is shorter than requested.

Dry-run reads no credentials and performs no network request:

```powershell
bun run collect:relay-container:ring-transition:deployment-sets -- `
  --transition-manifest <transition-manifest.json> `
  --transition-trust-policy <transition-policy.json> `
  --authorization-id-sha256 <sha256> `
  --execution-nonce-sha256 <different-sha256> `
  --dry-run `
  --json
```

Live readback is forbidden until the exposed credential has been revoked and
separate least-privilege read/deploy identities exist. The collector accepts no
token argument. Live mode reads only:

- `CINATOKEN_RING_TRANSITION_READ_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `CINATOKEN_EXPOSED_CREDENTIAL_REVOCATION_EVIDENCE_SHA256`;
- `CINATOKEN_RING_TRANSITION_READ_TOKEN_ID_SHA256`.

It additionally requires all four explicit confirmations:

```text
--confirm-staging-readback
--confirm-replacement-read-token
--confirm-exposed-credential-revoked
--confirm-no-mutation
```

The token stays only in in-memory `Authorization` headers. Every response body
is streamed into a 2 MiB ceiling, redirects are rejected, and the same deadline
covers headers and body. Output contains only the account and verified token ID
hashes, normalized deployment facts, version-detail digests, and transition
identities.

## Verification

Inspect the authorization contract:

```powershell
bun run plan:relay-container:ring-transition:authorization
```

Verify a prepared authorization packet:

```powershell
bun tools/verify_relay_container_ring_transition_authorization.mjs `
  --transition-manifest <transition-manifest.json> `
  --transition-trust-policy <transition-policy.json> `
  --authorization-manifest <authorization.json> `
  --authorization-trust-policy <authorization-policy.json> `
  --json
```

The authorization verifier reads no environment variable, opens no network
connection, starts no subprocess, writes no file, and emits no executable
command. Both trust-policy paths are operator inputs, so this command verifies a
signed packet but does not establish an immutable trust root. A future runner
must load pinned transition and authorization policy digests from deployment
configuration that the packet caller cannot select.

## Optimistic Concurrency Boundary

Cloudflare's deployments endpoint creates a new percentage deployment but the
locally pinned API surface does not expose a conditional request tied to the
previous deployment digest. This contract therefore calls the mechanism
application-level optimistic concurrency, not atomic Cloudflare CAS.

The future runner must:

1. match both policy digests against immutable runner configuration;
2. atomically insert the authorization ID and nonce into a D1 table with a
   unique key and expiry;
3. reject already claimed, expired, mismatched, or terminal claims;
4. collect T1 immediately before Controller mutation and compare it with the
   signed readback;
5. submit the Controller mutation once;
6. on response loss, read back and classify applied/not-applied/ambiguous,
   never blindly retry;
7. prove the exact Controller target before reading Edge again;
8. abort on Edge deployment-set drift;
9. submit the Edge mutation once and prove its exact target;
10. durably record request IDs, before/after digests, step state, and failure
   class without credentials or raw provider/customer payloads.

Until this claim authority and runner exist and pass fault tests, the
authorization is not executable by repository tooling.

## Partial Success

If Controller reaches the transition version and Edge does not:

- do not roll the Controller generation backward;
- retain the dual-ring Controller as drain owner;
- leave Edge at the reviewed previous version if it is still exact;
- keep Go/VPS as traffic and scheduler authority;
- disable Rust admission through the reviewed forward-safe path;
- repair forward through a new readback and authorization packet.

Cleanup is a different mutation. Resetting the four previous-ring variables to
zero requires complete drain evidence and a separate close-transition
authorization.

## Current Boundary

Local tests prove schema, signature, time, authority, actual-file hashing,
transition rebinding, deployment response normalization, stable double
readback, minimum-window and freshness enforcement, cross-stage approval-key
isolation, version-detail drift rejection, zero retry, credential-free CLI
verification, and redacted dry-run behavior.

They do not prove actual credential revocation, remote token permissions,
Cloudflare propagation, distributed claim uniqueness, mutation response-loss
classification, Controller/Edge post-readback, Container lifecycle, accounting,
load/SLO/cost, or rollback. No Cloudflare request was made in this increment.
Production remains **NO-GO**.
