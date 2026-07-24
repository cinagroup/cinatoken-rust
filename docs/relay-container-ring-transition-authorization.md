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
| `credential-scope-readback` | Exposed credential revoked; pairwise-distinct replacement read/claim/deploy credential identities; separate least-privilege scope assertions; no token value |
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
separate least-privilege read/claim/deploy identities exist. The collector accepts no
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

Until the private claim-authority service and immutable enabled runner artifact
exist and pass fault tests, the authorization is not executable by repository
tooling.

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

## 0059 Execution Claim And Runner Overlay

Migration `0059_relay_container_ring_transition_claims.sql` now provides the
local single-use execution ledger required by this authorization. It creates an
expiring unique claim plus append-preserved ordered step evidence. The claim
binds the authorization/nonce, both signed policy domains, transition and
candidate digests, execution plan, account and ledger identities, exact
Controller/Edge old and target versions, and runner build/trust digests.

Credential evidence now contains pairwise-distinct read, claim, and deploy
identity hashes and separate least-privilege assertions. Claim-readiness
evidence additionally binds the claim-authority origin hash, 0059 head, exact
claim/step table names, ledger identity, and claim credential. Secret values
remain forbidden.

The execution states are:

```text
claimed -> t1_verified -> controller_inflight -> controller_verified
        -> edge_prechecked -> edge_inflight -> completed

claimed|t1_verified -> aborted|expired
controller_inflight|controller_verified|edge_prechecked|edge_inflight
  -> recovery_required
```

Both mutation intents must be persisted before their corresponding remote
write. An inflight state schedules authenticated readback, never another write.
Stable double readback of the exact target at 100 percent confirms application;
any unresolved or drifting observation seals recovery and requires a new signed
forward-repair packet.

The checked-in runner trust object is deliberately unpublished and disabled.
The CLI can only describe the contract or fail closed; it reads no credentials
and performs no network request. A real staging execution still requires a
dedicated private claim-authority Worker, a reviewed immutable runner artifact
with build-time trust pins, native bounded zero-retry transports, exposed-token
revocation, remote 0059 readback, and the complete fault campaign. Production
remains **NO-GO**.

## 0060 Authority And Expiry Overlay

This overlay supersedes only current-head and current authority behavior in the
0059 overlay. Current local workspace D1 head/count is `0060/60`, with 69
required tables, 909 checked incremental columns, and 101 key indexes.

Migration 0060 separates expiry authority from execution ownership. The
expiry-event actor must not equal `claim_owner_sha256`, D1 time must prove the
claim has expired, and the resulting terminal state depends on mutation
progress:

Before applying 0060, disable every 0059 writer and prove there are no claims
in `claimed`, `t1_verified`, either inflight state, `controller_verified`, or
`edge_prechecked`. The migration's temporary drain guard aborts otherwise
because an old writer cannot supply the new transport evidence.

| Current state | Expiry result | Reason |
| --- | --- | --- |
| `claimed`, `t1_verified` | `expired` | No Cloudflare mutation has been persisted as sent |
| `controller_verified`, `edge_prechecked` | `recovery_required` | A control-plane mutation may already be effective and must be repaired forward |
| `controller_inflight`, `edge_inflight` | No expiry transition | Only authenticated stable readback may classify the one persisted mutation intent |

Every Controller or Edge post-readback step must bind the exact
`mutation_request_sha256` stored by the immediately preceding intent.
`transport_outcome` is explicit evidence:

- `not_applicable` for read-only, intent, abort, and expiry transitions;
- `success` for an accepted request with confirming readback;
- `ambiguous` for response loss or transport uncertainty classified by stable
  authenticated readback; and
- `rejected` only for `recovery_required/http_rejected`.

A rejected transport can never advance to `controller_verified` or
`completed`.

### Staging Authority trust boundary

The planned Authority Worker is staging-only and uses a dedicated
`cinatoken-ring-control-staging` D1. Besides provider-managed migration
metadata, that database contains only the claim, step, and expiry-event tables.
The Worker has only that D1 binding and Version Metadata. It has no application
D1, KV, R2, Durable Object, Container, Queue, service, AI, browser, or outbound
URL authority.

The current local Worker configuration names the dedicated
`cinatoken-ring-control-staging` database, but its database ID and trust
identities remain placeholders, every write gate remains false, and no
authenticated remote D1, route, Access, secret-rotation, or revocation evidence
exists. It is therefore not eligible for staging deployment or P5 evidence.

The exact machine endpoints are:

```text
GET  /internal/v1/ring-transition/preflight
POST /internal/v1/ring-transition/claims
GET  /internal/v1/ring-transition/claims/{authorization_id_sha256}
POST /internal/v1/ring-transition/claims/{authorization_id_sha256}/steps
POST /internal/v1/ring-transition/claims/{authorization_id_sha256}/expire
```

Every request passes Cloudflare Access Service Auth and an application HMAC
that binds method, normalized path, timestamp, unique request ID,
authenticated credential identity, and canonical body digest. Claim creation
also carries a short-lived Ed25519 permit that binds the claim digest,
authorization ID, signed policy and candidate identities, account and control
ledger, exact Controller/Edge targets, runner/build/trust identity, claim owner,
credential identity, and D1-compatible expiry bounds. The Worker verifies the
permit using deployment-pinned public keys. It derives the claim credential and
expiry actor from authenticated configuration and never accepts caller claims
that authorization or signature verification already occurred.

Create, step, and expiry writes use fixed prepared statements, no `OR IGNORE`,
`REPLACE`, UPSERT, general SQL, or retry-on-ambiguity. Every attempted write is
followed by an exact primary readback in the same D1 session. A matching row is
an exact replay; a mismatch is a conflict; unavailable readback is
outcome-unknown and permits only later GET, never a repeated mutation.

Tracked staging configuration requires `workers_dev=false`,
`preview_urls=false`, all authority/write gates false, and no production
configuration. Access, HMAC, and Ed25519 are independent layers; possession of
one does not substitute for either of the others.

No Authority Worker, control D1, Access policy, HMAC secret, permit key, route,
migration, or deployment has been created remotely. Exposed-credential
revocation evidence and every remote staging fault/readback gate remain open.
Production remains **NO-GO**.

## Immutable Runner And Transport Overlay

The local Authority now implements the five exact endpoints above. Preflight
is deliberately read-only: it authenticates the request, requires an empty
body, performs no D1 operation, and returns only `authority_ready`, request ID,
authenticated credential hash, deployment-pinned permit SPKI fingerprint, and
Version Metadata ID. The runner pins all returned identities before it may
send a claim request.

The portable native transport separates four runtime handles: raw account ID,
Cloudflare read token, Authority HMAC secret, and Cloudflare deployment token.
The three credential identities must be pairwise distinct. Read/deploy tokens
are verified against the exact account before use; the claim credential is
verified through preflight. The HMAC binds issuer, audience, key ID,
credential, request ID, method, normalized path, canonical-body digest and
time. Redirects, arbitrary origins/services, ambient environment scanning,
shells, SDK retries and `force` are absent.

The production trust root is the compiled Rust launcher, not the JavaScript
reference module. Its checked-in release is disabled and runtime inputs cannot
replace its embedded identity. An enabled artifact remains prohibited until a
clean two-build digest, strict canonical manifest, source/module inventory,
test evidence, release policy and independent DSSE Ed25519 signature are
verified and the artifact is installed by digest outside the checkout.

The JavaScript reference now snapshots and freezes its validated trust data,
and it rejects overlap among transition-approval, authorization-approval, and
permit signing keys. Its deployment write boundary requires an opaque,
single-use `freshIntentPermit`. Only an exact Authority `step_appended`
response for the just-persisted Controller or Edge intent creates that
capability. The response must match the authorization ID, claim digest, state
version, status, and step digest. Replay, response ambiguity, caller
construction, cloning, and process restart cannot recreate it.

Before the one POST, the capability is consumed and the transport verifies the
complete signed claim, current validity window, credential identities,
service/target, canonical body, full authorization annotation, semantic intent
digest, and persisted request digest. A mismatch fails before `fetch`. This
closes the reference transport's arbitrary-valid-version gap, but does not
replace the required Rust implementation or remote fault proof.

After release verification, the Rust orchestrator integration must resume
solely from the exact Authority claim. A persisted inflight mutation may
perform stable readback but can never schedule a second POST under the same
authorization. No signed enabled release or live orchestration exists yet;
production remains **NO-GO**.

## Rust Orchestrator Core Overlay

The offline Rust orchestration core exists; release verification, credential
loading, HTTP clients, stable-read timing, receipt persistence and live
orchestration remain open.

The Rust parser accepts only a bounded, strict Authority snapshot. It rebuilds
the claim and complete step/expiry history rather than trusting independently
queried `state` as a decision oracle. Every state version must occur exactly
once, each transition must match the 0060 protocol, execution steps must use
the claim owner, expiry must use a different Authority actor, post-readback
must repeat the preceding intent request digest, and reconstructed final
status/time must match the state row.

The pure reducer has no deployment-write result. It selects a new intent append
only from `t1_verified` or `edge_prechecked`; either inflight state always
selects observation, including after expiry. Pre-mutation expiry waits for the
Authority to record `expired`; post-Controller pre-Edge expiry waits for
Authority-owned `recovery_required`.

Write authority is represented by consumed types:

```text
VerifiedSnapshot
  -> PreparedMutationIntent<S>
  -> AuthorityAppendAttempt<S>
  -> FreshIntentPermit<S>
  -> AuthorizedMutation<S>
```

`AuthorityAppendAttempt<S>` binds one request ID and is not cloneable. Only an
exact `step_appended` response consumes it into `FreshIntentPermit<S>`;
`step_replayed` does not. The permit is private, non-cloneable,
non-serializable and consumed when the exact canonical request digest is
bound. Claim expiry is carried through the type chain and rechecked at the
final bind; the resulting authorized value retains the deadline for a second
check immediately before network I/O. Controller and Edge are distinct sealed
phase types, so a Controller permit cannot authorize an Edge target or state
version.

The future Rust deployment client must accept only
`AuthorizedMutation<S>` at its sole POST call site. This rule is not yet
integrated or remotely proven. A signed release, current-executable
verification, bounded Authority/Cloudflare clients, two timed stable reads,
hash-chained receipt and full crash/restart campaign remain required. The
checked-in launcher is still disabled, no remote operation occurred, and
production remains **NO-GO**.

## Read-Only Receipt Non-Authorization Overlay

The current native runner now integrates the typed deployment client and
durable mutation/read Operation Receipt V1 gates described in later migration
overlays. This section supersedes only the earlier implementation-status
sentences; the authorization model remains unchanged.

A read receipt never constructs `FreshIntentPermit<S>`,
`AuthorizedMutation<S>` or any other write capability. Its local request nonce,
absolute HTTPS target digest, `request_started`, HTTP `200` or terminal
`accepted` outcome cannot advance Authority state. Exact Authority history
selects the reducer, and stable Cloudflare observations supply only the
evidence accepted by that reducer.

After claim expiry:

- Authority claim read, Authority preflight and read/deploy credential proofs
  may run for at most 600 seconds to observe recovery without write authority;
- Cloudflare deployment/version observations cannot start; and
- every Authority append and Cloudflare deployment start remains forbidden.

An existing read start is zero-network and cannot be replayed into a new send.
An unfinished start is sealed ambiguous. The authorization has 128 immutable
create-new capacity markers; the 129th operation persists no directory/start
and cannot progress to network. A crash-stranded marker consumes capacity but
creates no authority and is never reused. A marker-backed directory with no
slot 1 is the same non-authorizing crash state: audit skips it, recovery
creates no finish, and only the exact operation can later publish its start
through the normal reservation path. None of these rules makes the local
receipt tree authoritative or replacement-resistant; terminal operation-head
binding and an independent signed/WORM anchor remain required.

Checked-in execution trust remains disabled. Go/VPS remains the traffic,
scheduler and financial authority, and production remains **NO-GO**.
