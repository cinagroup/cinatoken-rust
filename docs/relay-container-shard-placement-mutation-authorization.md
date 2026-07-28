# Relay Container Shard Placement Mutation Authorization

Date: 2026-07-28

Status: local implementation now includes staging-only permit verification,
atomic application-D1 consumption, Controller pre-wake enforcement, a private
four-role Authority foundation, an inert zero-retry runner plan, root-only
0063 readback, and P5 v4 authorization-row binding. The Authority is not a
private-key signer, its issuance/revocation ledger is not yet atomically joined
to application D1, and the runner has no live claim, workload routes, or
mutation capability. No remote schema, live permit, writer-enabled deployment,
placement evidence, or production authority is claimed. Production remains
**NO-GO**.

## Purpose

The placement writer can create durable placement identity and wake a Container.
It therefore cannot be enabled by an ordinary configuration edit or by a
campaign request authenticated only as root. This contract adds a separate,
short-lived, single-use Ed25519 authorization that binds one exact staging
Controller candidate and one exact activation campaign.

The target boundary has five independent layers:

1. four independent owners approve a canonical subject and an external
   private-key system signs the compatibility permit;
2. a private Authority verifies the four approvals and permit, then records
   one append-only issuance or revocation;
3. the edge Worker verifies the permit against deployment-pinned public trust;
4. application D1 atomically consumes the permit before creating its campaign;
5. the Controller and final placement trigger require the consumed permit
   before any Durable Object lookup, wake, or placement append.

Layers 3-5 are connected locally. Layer 2 has an isolated service/D1
foundation, but it is intentionally unreachable from a public route and is
not yet the atomic campaign-consumption authority. Layer 1 private keys remain
external by design. The repository's offline JavaScript verifier remains a
cross-runtime reference and release test; it cannot authorize a Cloudflare
mutation.

## Fixed Scope

The v1 permit is valid only for:

- environment `staging`;
- Controller service `cinatoken-container-controller-staging`;
- the existing default-jurisdiction campaign v1 and placement v1 contracts;
- one Controller version, runtime build, ring generation, shard count, action
  gate inventory, foundation manifest, campaign ID, and campaign nonce;
- one 60-3600 second activation campaign; and
- a permit lifetime of 60-600 seconds with at least 60 seconds remaining when
  D1 consumes it.

Production has no placement-authorization trust variables. Migration 0063
also rejects any authorization row whose environment or Controller service is
not the fixed staging identity. Restricted jurisdictions remain impossible:
the 0061 placement guard still accepts only `default`, and campaign v1 has no
jurisdiction field.

## Canonical Permit

The contract name and signature domain are both:

```text
cinatoken-relay-shard-placement-mutation-authorization-v1
```

The signed subject contains these fields in this exact order:

1. `schema_version`
2. `contract`
3. `issuer`
4. `key_id`
5. `environment`
6. `authorization_id_sha256`
7. `execution_nonce_sha256`
8. `campaign_id`
9. `campaign_nonce_sha256`
10. `controller_service_name`
11. `controller_version_id`
12. `action_gate_inventory_sha256`
13. `foundation_manifest_sha256`
14. `runtime_build_id`
15. `ring_generation`
16. `shard_count`
17. `campaign_lifetime_seconds`
18. `issued_at`
19. `expires_at`

The domain bytes are written directly, with no NUL terminator and no domain
length. Each field is then encoded as canonical UTF-8 text preceded by one
four-byte unsigned big-endian length. Numbers use their canonical base-10
representation. The detached Ed25519 signature and SPKI use unpadded canonical
base64url. Rust and JavaScript share a frozen byte-for-byte vector.

The three replay identities
`authorization_id_sha256`, `execution_nonce_sha256`, and
`campaign_nonce_sha256` must be pairwise distinct lowercase SHA-256 values.
The Worker hashes the caller-provided raw campaign nonce and requires it to
equal the signed campaign nonce hash. Raw nonces, signatures, SPKI bytes, and
request bodies are never stored or logged.

## Deployment-Pinned Trust

Local and staging configuration declare four non-secret trust variables:

```text
CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_ISSUER
CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_KEY_ID
CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_SPKI_BASE64URL
CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_SPKI_SHA256
```

Checked-in values are empty and therefore fail closed. A staging release must
pin all four through reviewed deployment configuration. The verifier requires
an exact Ed25519 SubjectPublicKeyInfo prefix, 32-byte public key, canonical
base64url, and matching SHA-256 fingerprint. Issuer and key ID must match the
permit exactly.

The signing private key must never be a Worker variable, Wrangler secret,
repository file, command-line argument, CI artifact, or deploy-runner input.
The future Authority owns signing and returns only the bounded permit.

## D1 Single-Use Consumption

Migration
`0063_relay_container_shard_placement_mutation_authorizations.sql` advances the
application schema to 63 migrations and 72 tables. Its authorization table is
append-preserved and stores only:

- replay-resistant IDs and digests;
- signer issuer, key ID, and SPKI fingerprint;
- the exact candidate, campaign, ring, and shard binding;
- permit and campaign times; and
- consuming administrator ID and D1-derived consumption time.

Unique constraints reject replay of the authorization ID, execution nonce,
campaign nonce, subject digest, campaign ID, or campaign digest. D1 checks the
permit window against `unixepoch()` and assigns `consumed_at`; callers cannot
supply a different consumption time.

Campaign creation uses one D1 batch in this order:

1. insert the verified authorization;
2. insert the exact activation campaign;
3. append the administrator audit record;
4. read back the campaign; and
5. read back the authorization.

The campaign foreign key is deferred only so the authorization can be inserted
first. An `AFTER INSERT` campaign trigger then requires exact authorization,
candidate, gate inventory, campaign digest, lifetime, administrator, and
bounded timestamp agreement. The Worker returns success only after validating
both exact readbacks.

## Controller And Placement Enforcement

Before a writer-enabled readiness request can claim D1 or look up a Durable
Object stub, the Controller:

1. requires both placement-writer gates to be true together;
2. requires environment `staging`;
3. probes the exact 0061/0062/0063 schema;
4. reads the authorization joined to the campaign; and
5. requires complete candidate, campaign, time, signer, and digest agreement.

The 0063 replacement for the 0061 placement insert trigger is the final
independent guard. It requires the authorization to match environment,
Controller service/version, ring, shard count, campaign, and placement time
before it rechecks the complete 0054 activation and 0055 consumption chain.
An application bug cannot append a placement without the consumed
authorization.

Failure before D1 campaign creation is non-mutating. A lost response after an
atomic D1 batch is resolved through exact readback; the same permit cannot be
consumed for another campaign. Any signature, trust, schema, identity, time,
campaign, or readback drift fails closed.

## Authority Foundation And Remaining Work

`services/shard-placement-authority` now provides a staging-only, default-off
foundation. It has:

- one isolated D1 and Worker version metadata, with no application D1, KV, R2,
  Queue, Durable Object, Container, asset, or outbound service binding;
- no `workers.dev`, preview URL, custom route, or production configuration;
  staging ingress is service-binding-only;
- distinct HMAC caller roles for read, issue, and revoke, including
  current/previous credential identity slots;
- five distinct deployment-pinned Ed25519 public identities: permit signer
  plus security, operations, release, and rollback approval roots;
- bounded canonical JSON, strict UTF-8, exact fields, request-body and time
  limits, HMAC request binding, fixed role order, key/fingerprint isolation,
  and canonical SPKI verification;
- create-new issuance, exact replay, conflict, outcome-unknown, revocation,
  expiry, and no-store readback behavior; and
- append-preserved D1 rows containing safe digests, IDs, fingerprints, times,
  approval-set digest, and revocation evidence, never private key material or
  raw nonce/signature/SPKI bodies.

The Authority verifies an externally signed permit; it does not and must not
hold the permit private key. HMAC read/issue/revoke caller roles are transport
roles and never substitute for the four Ed25519 owner approvals.

Production readiness still requires the Authority boundary to:

1. pin its policy and public approval keys outside caller input;
2. require distinct security, operations, release, and rollback approvals;
3. bind the exact immutable Controller deployment version, source/provenance,
   runtime build, gate inventory, foundation manifest, ring, shard count,
   campaign ID, and expiry;
4. atomically join issuance, revocation, consumption, campaign, and placement
   enforcement in one dedicated control D1, or provide a formally proven
   cross-database protocol; the current two-D1 foundation does neither;
5. connect the implemented exclusive execution claim and predecessor-bound
   append-only step ledger to application-D1 activation through a reviewed
   cross-database protocol;
6. preserve replayable signed approval evidence in reviewed WORM storage while
   keeping private material out of Workers and D1;
7. support current/next-or-previous approval keys with explicit validity,
   status, retirement, and emergency revocation; and
8. sit behind a separately Access-protected approval gateway that holds no D1
   binding and reaches the Authority only through an exact Service Binding.

The Rust runner now freezes the first safe plan as
`cinatoken-relay-container-shard-placement-execution-plan-v1`: staging,
Controller-only, exactly eight shards, 13 deterministic mutation operation
slots, one send attempt per slot, zero retries, start receipt before send,
readback-only recovery for ambiguous outcomes, no resend when evidence is
missing, disable-first after the enable intent, and no Edge mutation. The
checked-in description explicitly reports Authority claim and workload routes
as uncompiled, reads no credentials, performs no network request or mutation,
and grants no remote or production authority.

Executable runner work still requires compile-time trust pins; separate
read/enable/rollback/Authority/gateway credentials; the exclusive Authority
claim/step ledger; non-root workload-authenticated campaign/readiness/status/
abort routes; complete Cloudflare deployment pagination; stable double
readback; and crash/fault tests at every persisted operation boundary.

## Staging Ceremony

The first eligible live ceremony is:

1. revoke the exposed historical Cloudflare credential and independently
   verify absence;
2. review replacement read, migration, and deploy credential scopes and prove
   identity separation;
3. apply 0061-0063 to isolated staging while all writer gates are false;
4. read back exact tables, columns, indexes, triggers, foreign keys, migration
   markers, and zero campaign/authorization/placement rows;
5. deploy the reader-first Controller candidate with gates false and retain its
   immutable version, settings, source, build, image, SBOM, and provenance;
6. collect four independent approvals and obtain one short-lived permit;
7. atomically consume the permit and create the exact campaign;
8. use the zero-retry runner to deploy the exact staging Controller version
   with both writer gates true; Edge remains on its signed baseline;
9. run one default-jurisdiction 8/8 activation campaign and collect stable
   campaign, activation, authorization, placement, event, runtime, lifecycle,
   accounting, SLO, fault, load, and cost evidence;
10. restore both gates to false, read back the disabled deployment, and revoke
    all campaign mutation credentials;
11. independently replay every canonical artifact on a clean verifier host;
    and
12. retire the candidate on any drift instead of editing immutable evidence.

No step may carry customer traffic, production authority, paid-provider side
effects outside the approved synthetic cohort, financial settlement, Go/VPS
drain, or DNS cutover authority.

## Acceptance And Rollback

A staging campaign is `proven` only when the four-role issuance, permit,
D1 authorization row,
campaign, N/N 0054 activations, N/N 0055 consumptions, N/N 0061 placements,
N/N 0062 events, Controller deployment, runtime image, and before/after
snapshots all bind the same candidate. The P5 shard registry now advances to
capture v4 and reads the same safe 25-column 0063 row before and after the
bounded observation. It requires a stable canonical row digest and exact
candidate/campaign/time linkage, and Foundation source v4 binds that evidence
into both candidate-freeze and remote-inventory facts. This closes the local
authorization-row join only; no live P5 evidence exists.

Rollback means disabling both writer gates, retaining the immutable failed
campaign and authorization, preventing new wakes, preserving Go/VPS authority,
and starting a new version/campaign/permit if another attempt is approved.
It never means deleting or rewriting 0063, 0062, 0061, 0055, or 0054 evidence.

## Local Verification

The local gate additionally covers:

- canonical Ed25519 verification in Rust and JavaScript;
- fixed-vector parity and signed-field tampering;
- malformed SPKI/signature and trust mismatch;
- lifetime, skew, remaining-time, and replay identity limits;
- D1 missing, mismatch, production, replay, immutability, and placement guards;
- campaign authorization insert/readback ordering;
- Controller schema/readback validation before Durable Object lookup; and
- Worker/Controller configuration default-off behavior.
- private Authority binding inventory, no-public-route policy, secret
  redaction, canonical four-role verification, concurrent exact replay,
  revocation, and append-only migration guards;
- root-first D1-only no-store 0063 readback with an exact safe projection; and
- the staging/eight-shard/Controller-only runner plan, deterministic operation
  IDs, receipt-capacity bound, single-send policy, ambiguous readback-only
  recovery, disable-first rule, and inert CLI description.

These tests prove local implementation consistency only. They do not prove
Cloudflare account state, credential rotation, remote D1 schema, an Authority
deployment, a live signature, a writer-enabled version, a Container wake, P5,
customer traffic, billing, Go/VPS drain, DNS cutover, or production readiness.

Current focused verification passes the Authority type/dry-run/protocol/
Workerd/config/migration aggregate, the three P5 suites, the new Worker
authorization-reader tests, and the runner placement-plan/CLI tests. The full
repository aggregate passes with exit code 0 in 1000.6 seconds. The remote
staging ceremony must still be run for the final candidate. Existing Rust
`dead_code` findings remain warnings only.

## Execution Claim And Lease Ledger Checkpoint

Migration `0002_shard_placement_execution_claims.sql` and the private
Authority Worker now implement the local execution-ownership boundary. This
supersedes the earlier statement that no cross-host claim or predecessor
ledger exists. It does not supersede the separate statement that application
D1 consumption and Authority D1 execution are not yet atomically activated.

The implemented contract has these invariants:

- one active `staging-controller-placement-v1` scope, enforced by a partial
  unique index that is not released merely because a lease expires;
- one immutable claim identity bound to permit subject, authorization,
  execution and campaign nonces, candidate digests, initial owner, ledger,
  operation-1 terminal receipt, operation-2 claim identity, caller credential
  and request ID;
- exactly 11 persisted operations for ordinals 3-13, with fixed kinds and
  shard order, plus one D1-created sequence-1 acquisition receipt;
- D1-owned `claimed_at`, `recorded_at`, and 60-second lease expiry;
- a maximum 64-event append-only predecessor chain with unique start and
  terminal receipts per operation;
- renewal under the current owner/token/generation only, and takeover only
  after D1 observes expiry, with a new owner, token, and generation;
- an in-flight operation inherited by a takeover is readback-only and can
  never regain send authority; and
- operation 3 start records the enable intent. Revocation, failure, unresolved
  work, safety diversion, or post-enable takeover forces
  `disable_required`, where only operation 13 may start.

Successful operation-13 terminal evidence is the only path to `completed`.
An unproven disable ends in `recovery_required`. Separate claim,
normal-receipt, and recovery HMAC roles are required in addition to read,
issue, and revoke.

The private routes are:

```text
POST /internal/v1/shard-placement/execution-claims
GET  /internal/v1/shard-placement/execution-claims/{authorization}
POST /internal/v1/shard-placement/execution-claims/{authorization}/receipts
POST /internal/v1/shard-placement/execution-claims/{authorization}/renew
POST /internal/v1/shard-placement/execution-claims/{authorization}/takeover
POST /internal/v1/shard-placement/execution-claims/{authorization}/safety-divert
```

All write gates remain false in checked-in local and staging configuration.
The service still has no public route, `workers.dev`, preview URL, production
configuration, application D1, Durable Object, Container, Queue, KV, or R2
binding.

### Cross-database activation gate

The execution claim alone cannot authorize operation 3. The next application
migration must add a create-new activation ticket and a fail-closed
two-ledger handshake:

1. application D1 atomically creates the authorization/campaign intent and a
   `prepared` ticket bound to authorization, campaign, candidate, operation
   schedule, Authority database identity, and deadline;
2. the runner creates the exact Authority claim bound to the ticket digest;
3. application D1 CAS-activates the ticket only while 0063 remains active and
   the returned claim digest matches;
4. Authority appends an activation acknowledgement only after exact
   application-D1 readback; and
5. operation 3 remains forbidden until both immutable ledgers contain the
   same activated tuple.

Timeout, conflict, missing readback, or revocation before activation grants no
mutation authority. Any uncertainty after operation 3 grants only
operation-13 disable/readback authority. Consolidating these records into one
D1 remains preferable; this handshake is the required fallback.

### Remaining runner gate

The Rust runner does not yet emit this Worker wire contract. An incompatible
prototype was intentionally not admitted. Before a live client is compiled,
Rust and TypeScript must share checked-in canonical claim, acquisition,
renewal, takeover, operation-start, operation-terminal, and safety-diversion
vectors. The transport must persist exact request bytes before its only POST,
recover response loss by exact GET/readback, never regenerate a send permit,
and prove stale generations cannot issue network requests.

Focused local verification now passes 10 protocol tests, 3 Workerd lifecycle
tests, and 8 migration/config tests, plus type generation and Wrangler
dry-run. The complete repository gate also passes with exit code 0 in 929.3
seconds; existing Rust `dead_code` findings remain warnings only. No remote
migration, deployment, credential read, gate change, claim, campaign,
Container wake, or traffic action occurred. Production remains **NO-GO**.

## Two-Ledger Execution Ticket Overlay

Migration `0064_relay_container_shard_placement_execution_tickets.sql` and
Authority migration 0002 now implement the local fallback described above.
This section supersedes the provisional operation numbers and the statement
that the application activation ticket does not exist. It does not claim
cross-D1 atomicity or a deployed handshake.

### Canonical operation schedule

| Ordinal | Record owner | Operation |
| --- | --- | --- |
| 1 | runner evidence | prove exact disabled baseline |
| 2 | application D1 | consume 0063 authorization and prepare ticket/campaign |
| 3 | Authority D1 | acquire the exclusive ticket-bound claim |
| 4 | both ledgers | activate ticket and mirror Authority acknowledgement |
| 5 | Authority D1 | record enable intent and deploy the enabled Controller |
| 6-13 | Authority D1 | execute shard 0-7 readiness probes in order |
| 14 | Authority D1 | deploy and prove the disabled Controller |

The ticket is immutable and create-new. It binds the signed authorization,
campaign, candidate, exact schedule, Controller versions, release and runner
identities, permit/campaign/execution deadlines, application database
identity, Authority database identity, and Authority ledger identity.
Application activation binds one exact Authority claim. The acknowledgement
binds the exact Authority version, ledger head, operation-4 terminal evidence,
and application activation digest.

All three database/ledger identities are deployment-owned lowercase SHA-256
values and must be pairwise distinct. The campaign creator cannot inject
them. Ticket execution expiry equals campaign expiry and cannot exceed permit
expiry. A claim after any relevant deadline fails closed.

### Enforced pre-enable proof

Application D1 permits a campaign claim only when the immutable activation and
Authority acknowledgement rows match the prepared ticket. Authority D1
permits operation 5 only after operation 4 has terminated successfully and
projected the exact application activation digest. The Controller requires
the same four-way application-D1 join before it looks up a Durable Object.

Exact claim-create replay remains valid after later receipts advance the
Authority ledger. This classifies a lost create response by readback without
issuing another mutation attempt. Revocation, expiry, mismatch, missing
readback, or a partially written handshake grants no enable authority.

### Required live protocol

The checked-in state has no application activation or acknowledgement write
route and no Authority workload route that reads application D1. Those
omissions are intentional local safety gates. The live implementation must:

1. activate the application ticket only after authenticated exact Authority
   claim readback and a current 0063 revocation/lifetime check;
2. let Authority operation 4 read the exact application activation only
   through a pinned private Service Binding;
3. mirror the Authority acknowledgement only after an authenticated exact
   receipt-chain and ledger-head snapshot;
4. repeat revocation and deadline checks immediately before operation 5;
5. keep one guaranteed terminal-disable receipt budget despite renewals,
   takeovers, and recovery events;
6. use separate, least-privilege, rotated credentials for read, claim,
   activation, acknowledgement, normal receipt, recovery, and deployment;
7. prove deterministic Rust/TypeScript vectors for every canonical digest;
   and
8. pass response-loss, concurrent-runner, stale-generation, stale-ledger,
   corruption, revocation, timeout, and uncertain-disable fault campaigns.

Consolidating the control chain into one dedicated D1 remains the simpler
transaction model. Retaining two D1 databases is acceptable only if the live
implementation and evidence demonstrate that every partial state is
fail-closed and can never authorize operation 5.

No remote migration or deployment may begin until the historical exposed
Cloudflare credential is revoked and independently proven absent. All tracked
writer gates remain false. The complete repository gate passes with exit code
0 in 1043.0 seconds; the Worker library separately passes 875 tests, and
existing Rust `dead_code` findings remain warnings only. Go/VPS remains
authoritative and production remains **NO-GO**.

## Application Activation Writer Checkpoint

The application half of operation 4 is now implemented locally. This section
supersedes the statement above that no application activation write route
exists, but not the requirement for the Authority receipt and application
acknowledgement halves.

The root-authenticated, secure-verification-gated route reads one exact
Authority claim through the private `SHARD_PLACEMENT_AUTHORITY` Service
Binding. The read uses the v1 canonical HMAC contract, a three-second timeout,
a 128 KiB response bound, strict JSON, `Cache-Control: no-store`, and no
redirects. A Rust token fixed vector is accepted by the TypeScript Authority
verifier. Secret material is obtained only through `env.secret`.

The route rejects a non-staging ticket, caller-supplied deployment facts,
wrong database or ledger identities, a missing or additional receipt, any
claim/ticket digest drift, a lease generation other than 1, an incomplete or
reordered operation 4-14 schedule, an in-flight operation, any prior
activation/enable/takeover/renewal projection, a Controller baseline that is
not exactly disabled, or a deadline reached according to application D1
`unixepoch()`.

Application activation is create-only. One D1 batch inserts the canonical
activation, appends the administrator audit record, and reads the inserted row
back. Exact replay validates all stored evidence and never overwrites or
regenerates it. Race recovery accepts only the same canonical row.

This row records an observed Authority snapshot and grants zero enable
authority. The Authority operation-4 writer must re-read and conditionally
consume its current claim, version, ledger/receipt head, lease generation,
deadline, and revocation state. A renewal, takeover, safety diversion, or
revocation between the application GET and INSERT must make operation 4 fail
closed rather than treating the application row as proof of freshness.

Both the Authority read gate and activation write gate are false in local and
staging configuration; production has no binding or gate. This route is a
root-operator bootstrap path, not a production runner identity. The remaining
pre-enable chain is:

1. expose a private/scoped application activation read boundary;
2. have Authority operation 4 read that exact row and append/read back its
   terminal receipt;
3. mirror the exact Authority acknowledgement into application D1;
4. close the revocation race immediately before operation 5; and
5. retain guaranteed operation-14 disable and recovery authority under every
   timeout, lease, response-loss, and version-skew case.

Until all five steps and their remote evidence are complete, operation 5 has
zero mutation authority. Go/VPS remains authoritative and production remains
**NO-GO**.

The complete local repository gate passed with exit code 0 in 935.6 seconds;
the Worker library passed 886 tests.
