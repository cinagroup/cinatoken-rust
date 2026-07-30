# Relay Container Drain-Source Registration Command (0074)

## Status and decision

This document is the current, superseding contract for migration
`0074_relay_container_drain_source_registration_command.sql`.

It supersedes only the earlier design assumptions that registration would
produce four changes, that the permit issue request had 33 fields, or that the
permit subject had 43 fields. Those historical checkpoints remain in
`cinatoken-rust-migration-plan.md` as an audit trail. The current local
candidate has:

- a 57-field action subject;
- a 39-field permit issue request;
- a 49-field permit subject;
- one top-level D1 `INSERT` with exactly five durable effects on a fresh
  command and zero effects on exact replay; and
- a same-Session readback covering four immutable effects (command, protected
  audit, 0073 registration, and registration ledger receipt) plus current
  passkey post-CAS state when it still exists. A fresh `changes=5` result
  requires all five; historical exact replay does not depend on mutable
  passkey state.

This is local candidate evidence, not production authorization. No public
route, production Service Binding, production trust tuple, enabled write gate,
remote D1 migration, traffic change, or Go/VPS retirement follows from the
local 0074/0075/0076 chain. Go/VPS remains authoritative and production
remains **NO-GO**.

## Source-system decisions

### cinatoken-go on VPS

The Go service remains the behavioral and production reference. The migration
retains its useful properties:

- role and status checks around Root operations;
- phishing-resistant passkey verification and authenticator counter handling;
- structured `op`, `admin_info`, and `audit_info` log shapes;
- transactional compare-and-swap and idempotency patterns used by mature
  business paths; and
- the complete relay, retry, task, billing-expression, settlement, and
  reconciliation semantics that are still production authoritative.

The Cloudflare writer does not copy several VPS-local assumptions:

- `RootAuth` or a reusable secure-verification marker alone is insufficient
  for a drain-source registration;
- a mutation followed by a best-effort log insert is not an atomic audit;
- deleting and recreating a passkey row is not a stable credential identity
  or a safe authentication-use CAS;
- process memory, a single database connection, or one server clock cannot be
  the global linearization authority; and
- an external side effect must not happen before durable intent and recovery
  identity exist.

The 0074 consequence is deliberate: the familiar Go audit projection remains
readable, but D1 derives it from the same command that consumes the passkey
proof and creates the registration. Audit failure aborts the registration.

### cinaVibeSDK on Cloudflare

The cinaVibeSDK audit contributes the deployment model:

- deterministic named Durable Objects own local coordination;
- Durable Object SQLite is serialized local state;
- Containers are disposable execution workers reconstructed from persistent
  state;
- D1 is global application truth, R2 holds large retained artifacts, and KV
  is only a non-authoritative cache; and
- Worker-to-DO and DO-to-Container calls use private bindings or RPC.

The production design rejects source patterns that do not survive resizing or
loss:

- `hash(session) % instanceCount` ownership;
- a session ID as permanent shard identity;
- in-memory timers, promises, or unbounded retry as durable state;
- process health, shutdown, or Container absence as accepted-work drain
  evidence; and
- metadata written only after process, filesystem, provider, or deployment
  I/O.

A Durable Object may serialize one shard's coordinator, but it cannot decide
the globally unique winner for a Root registration. The 0074 D1 command is the
global linearization point. It performs no Container or provider I/O.

## Closed typed evidence chain

The writer is assembled from verified types, not request strings:

```text
VerifiedDrainSourceAuthorization
  -> ValidatedDrainSourceRegistrationChallenge
  -> DrainSourceRegistrationActionV1
  -> one-shot mandatory-UV WebAuthn challenge
  -> VerifiedDrainSourceRegistrationPasskeyProof
  -> ValidatedDrainSourceRegistrationIssuer
  -> exact frozen isolated issuer request
  -> VerifiedDrainSourceRegistrationPermit
  -> ValidatedDrainSourceRegistrationCommit
  -> VerifiedDrainSourceRegistrationCommand
  -> one 0074 D1 INSERT
```

The action subject freezes the authorization, current admission fence and
scope head, collector/source bounds, ledger predecessor, Root identity and
session, credential identity, writer provenance, action/request/audit
digests, a keyed network-identity pseudonym, reason, change ticket, origin,
RP ID, nonce, and validity interval. The WebAuthn verifier returns only
digests of already verified bytes.

The isolated permit verifier binds the authenticated issuer request ID and
issuer deployment version in addition to the signed subject, signer identity,
key ID, SPKI digest, permit ID, and signature-envelope digest. The verified
permit is opaque to route code.

`VerifiedDrainSourceRegistrationCommand::from_validated_commit` accepts only
the opaque result of the latest-D1-time before-commit validator. That
validator has already consumed the exact frozen issuer request and verified
permit, recomputed the canonical commit phase binding, and enforced the
parent-proof chain. Command assembly still cross-checks every shared action,
proof, and permit binding and derives the issuer-request digest,
secure-verification receipt, command ID, and registration receipt internally.
A route cannot supply those identities, call the old three-argument
constructor, or downgrade a verified type to raw strings.

## Session lifetime binding

The phase-proof layer represents the Root session with five distinct facts:

- `root_session_epoch`: exact monotonic revocation generation;
- `root_session_binding_sha256`: digest binding the exact authenticated
  session;
- `root_session_id_sha256`: digest binding the random per-issue Cookie `sid`;
- `root_session_issued_at`: session iat; and
- `root_session_expires_at`: session exp.

The exact generation, Cookie-binding digest, iat, and exp continue through the
action, issuer request, signed permit, verified command, and D1 command row.
The separate session-ID digest remains in the proof/coordinator operation
state; the downstream Cookie-binding digest also commits to the signed Cookie
that contains that `sid`. The typed and SQL contracts require:

```text
cookie.session_epoch == live D1 session_epoch
session_iat < session_exp
session_iat <= verified_at
verification_expires_at <= session_exp
verified_at <= permit_issued_at < permit_expires_at
permit_issued_at - verified_at in [0, 5]
permit_issued_at <= D1 created_at + 5
D1 created_at < min(session_exp, permit_expires_at)
```

`created_at` comes from D1 `unixepoch()`, not a caller. This prevents a valid
passkey proof or permit from being used after the bound session lifetime.
Generation is deliberately absent from every timestamp inequality.

Immutable 0074 predates that correction and retains both historical predicates
byte-for-byte. Additive 0076 first proves the exact 0074/0075 schema closure
and empty command, protected-audit, registration, claim, terminal, and ledger
state. It then rebuilds the effective command table and direct trigger closure
without comparing generation with time. The 22 normalized SQL objects and
three PRAGMA contracts are refrozen; SQLite and Workerd prove preflight
rejection, post-drop rollback, and exact generation-greater-than-`iat` `5/0`.
Editing 0074 in place remains forbidden. Remote D1 apply and command writes
remain blocked.

The timestamps do not replace a fresh session-authority lookup. The future
private begin/finish coordinator must reread Root status, session epoch,
binding, iat, and exp before challenge creation, before issuer invocation, and
immediately before the 0074 insert. A current D1 epoch plus caller-carried
timestamps is not, by itself, production session proof.

## Passkey identity and 0/0 authenticators

Migration 0074 adds three immutable credential identities:

- `credential_registration_id_sha256`, derived from the consumed
  registration challenge and immutable credential metadata;
- `credential_id_sha256`, derived from the raw WebAuthn credential ID; and
- `credential_binding_sha256`, binding the registration identity to the same
  immutable metadata.

The three values are either all absent for a legacy row or all present and
pairwise distinct. A controlled legacy backfill may set them exactly once.
An M1 registration command requires all three.

WebAuthn authenticators are allowed to report sign count `0` forever. The
normal counter rule is therefore:

```text
(previous_sign_count == 0 && new_sign_count == 0)
OR new_sign_count > previous_sign_count
```

Sign count alone cannot consume a `0/0` assertion exactly once. The independent
`credential_use_generation` closes that gap:

1. a newly created credential starts at generation `0`;
2. action, proof, permit, and command bind the previous generation;
3. the command derives `next = previous + 1`, bounded by JavaScript's maximum
   safe integer;
4. the 0074 passkey update CAS matches row ID, user, all three credential
   digests, previous generation, previous sign count, clone state, and
   non-deleted state; and
5. every authentication-state update advances the generation exactly once.

Thus a valid `0/0` assertion changes generation `0 -> 1` even though sign count
remains zero. An exact command replay produces no update and remains at
generation `1`. A competing use that advances the generation makes the stale
0074 command fail before any registration effect survives. Because the command
must derive `next = previous + 1`, action, permit, issuer, and D1 all cap the
previous generation at JavaScript's maximum safe integer minus one. The
credential ID, immutable registration ID, and credential-binding digest must
also be pairwise distinct at every layer.

## Audit privacy and retention

The immutable command and protected audit never persist a plaintext client
IP or Root username. The future trusted coordinator must parse the trusted
network source as `std::net::IpAddr`, canonicalize it, and derive
`admin_network_identity_hmac_sha256` with:

```text
HMAC-SHA-256(
  secret_at_least_32_bytes,
  domain_v1 || u32be(len(canonical_ip)) || canonical_ip
)
```

Only the lowercase 64-hex HMAC enters the action, permit request, signed
permit, command, and protected audit JSON. The Rust input type has no
constructor from an arbitrary string; it can only be derived from a secret
and a parseable IP. The protected `logs.username` and `logs.ip` columns, plus
`admin_info.admin_username`, are fixed to empty strings. Stable operator
attribution uses `root_admin_id`, role-at-event, passkey evidence, session
binding, and the immutable command identities.

The HMAC key is not a database value or a general Application secret. Before
the private coordinator can be enabled, isolated staging must prove a
dedicated secret binding, source-header trust boundary, key-version and
rotation runbook, no request-body override, log/search redaction, retention
period, legal basis, access policy, and erasure/incident handling. Rotation
changes future pseudonyms and never rewrites immutable historical evidence.
The current signed chain does not yet carry the non-secret HMAC key ID/version.
That omission is a production blocker: before isolated staging, add the key ID
to the immutable chain or bind an equivalently immutable candidate-level
key-version map so historical pseudonyms remain attributable after rotation.

## Domain-separated derivation

Action, challenge, permit, and command identities use separate versioned
domains. Their canonical Rust encoders use unambiguous length-prefixed fields:

```text
SHA-256(domain || u32be(len(field_1)) || field_1 || ...)
```

Passkey credential-registration identities have their own versioned domains
and encoder, using `u64be` lengths. The encoders are intentionally not
interchangeable.

The current command-specific domains independently derive:

- authenticated issuer request ID digest;
- secure-verification receipt;
- registration command ID; and
- 0073 registration receipt.

Credential ID, registration ID, credential binding, action subject, WebAuthn
challenge, permit subject, permit ID, signature envelope, secure receipt,
command ID, and registration receipt all have distinct domains. The command
also rejects accidental equality among its three derived terminal identities.

Only digests and bounded audit metadata enter D1. Raw session cookies, raw
WebAuthn assertion bytes, private/HMAC keys, plaintext network addresses,
bearer credentials, execution nonces, and D1 bookmarks are not command
columns. The authenticated issuer request ID is retained only as its
domain-separated digest.

## One INSERT, five atomic effects

The only eligible mutation is an `INSERT ... SELECT ... WHERE NOT EXISTS`
against `relay_container_drain_source_registration_commands`. A fresh command
causes exactly five durable changes under one SQLite statement:

1. append the immutable 0074 command;
2. project one canonical protected Root audit into `logs`;
3. update the passkey row through the exact generation/sign-count CAS;
4. project the exact 0073 authorization registration; and
5. let the 0073 registration trigger append its registration ledger receipt.

The top-level command trigger validates the complete 0067-0074 migration
chain, D1 time, Root state, session lifetime, passkey identity and generation,
authorization, open admission fence, current scope head, current terminal
ledger predecessor, and absence of claim, terminal, or source scan.

The replacement 0073 registration guard requires the exact command, canonical
audit, and post-CAS credential state. A direct 0073 registration is no longer
valid. Command and protected audit rows are immutable and append-preserved.
Retention and smoke cleanup discover the pre/post-0074 log schema and exclude
protected rows after upgrade; ordinary unrelated log rows remain deletable.

Any failed validation, non-canonical audit, zero/multiple passkey update,
registration conflict, or ledger failure aborts the complete statement. There
is no state in which the audit exists without the command, the credential is
consumed without registration, or registration exists without its ledger
receipt.

Real Workerd currently proves:

- fresh command `meta.changes = 5`;
- exact replay `meta.changes = 0`;
- `0/0` sign count with credential generation `0 -> 1`;
- immutable command and append-preserved protected audit;
- passkey-generation drift leaves command, audit, registration, and ledger
  counts at zero;
- ordinary retention cleanup deletes ordinary rows while retaining protected
  audit rows; and
- exact replay remains `0` after the mutable passkey row is deleted.

## Same first-primary Session readback

The D1 Session is an ordering and read-your-writes mechanism, not a
multi-statement transaction. Atomicity comes from the single SQLite command.
The required repository protocol is:

1. create one `withSession("first-primary")` Session;
2. verify the exact 0074 schema/readiness fingerprints through that Session;
3. execute only the one top-level command statement in a Session batch;
4. inspect `success` and trigger-aware `meta.changes`;
5. through the same Session, read command, protected audit, optional current
   passkey, registration, and registration ledger rows;
6. compare every persisted field with the opaque verified command; and
7. expose only the bookmark SHA-256, never the raw bookmark.

Classification is fail closed:

| Batch/readback result | Classification |
| --- | --- |
| `changes=5`, exact immutable readback, and exact current passkey | `FreshApplied` |
| `changes=0` and exact immutable readback, regardless of later passkey change/deletion | `ExactReplay` |
| Stable alternate identity resolves to a different command | `Conflict` |
| Any other count, malformed metadata, exception, timeout, unreadable row, partial/mismatched readback, or schema drift | `OutcomeUnknown` |

After a batch error or response loss, the caller must not blindly insert
again. It first performs same-Session readback by command ID and stable unique
aliases, including authorization, permit, permit subject/envelope, issuer
request digest, action subject/digest, assertion, challenge, execution,
registration request/receipt, and protected audit identity.

`ExactReplay` is historical idempotency evidence only. A future coordinator may
return the already-created registration result, but must never turn replay into
fresh collection, claim, close, traffic-return, or any other authority.

The Workerd runtime test already performs the fresh and replay batches plus
the joined readback through one `first-primary` Session, then deletes the
passkey and proves another exact zero-change replay. The Rust repository now
implements the same route-free protocol: schema readiness, one 52-binding
command statement, trigger-aware batch classification, immutable projection
comparison plus fresh-only current-passkey comparison, 15 stable conflict
aliases, and
`FreshApplied`/`ExactReplay`/`Conflict`/`OutcomeUnknown`. It has no coordinator
or route.

## Migration preflight

0074 is intentionally incompatible with both a live 0073 registration writer
and a pre-0074 passkey authentication writer that does not advance
`credential_use_generation`. Its SQL preflight aborts unless all four 0073
consumption tables are empty:

- `relay_container_drain_source_authorization_registrations`;
- `relay_container_drain_source_authorization_claims`;
- `relay_container_drain_source_terminal_receipts`; and
- `relay_container_drain_source_receipt_ledger`.

This prevents retroactive command/audit linkage and ambiguous credential
consumption. The required apply order is:

1. keep Go/VPS authoritative and every drain/collector/registration gate off;
2. deploy the dual-profile passkey repository while D1 is still pre-0074; it
   projects legacy rows as `NULL/NULL/NULL/0`, uses legacy writes before the
   four new columns exist, rejects partial-column schema, and automatically
   switches to digest/generation CAS only after all four columns appear;
3. prove legacy passkey read, registration, and authentication behavior, then
   drain every older Worker version and in-flight passkey request;
4. stop and prove absence of all 0073 consumption writers;
5. retain D1 Time Travel/backup identity, migration inventory, normalized
   schema/trigger digests, and zero-row evidence;
6. apply 0074 first to a dedicated isolated-staging D1 database;
7. verify migration head, table/index/trigger PRAGMAs, the exact complete
   trigger closure for command/log/passkey tables, protected-log retention
   behavior, and the exact empty consumption baseline;
8. perform controlled credential identity creation/backfill and verify all
   three digests before any M1 ceremony; and
9. enable only a private, bounded, default-off staging coordinator after the
   complete local and remote fault matrix passes.

An old 0073 direct-registration writer or generation-unaware passkey writer
must never run after 0074. Reader compatibility does not imply writer
compatibility.

## Rollback and repair-forward

There is no production down migration. 0074 adds columns, unique indexes,
append-preserved evidence, and replacement guards; deleting them would weaken
the evidence chain.

Operational rollback is disable-first:

1. disable issuance, coordinator, registration, claim, collector, close,
   traffic-return, and reopen gates;
2. stop all new 0074 writes and keep Go/VPS serving authoritative traffic;
3. classify every uncertain command through stable first-primary readback;
4. preserve command, protected audit, passkey generation, registration, and
   ledger rows exactly as written;
5. retain remote schema, Time Travel, logs, bookmarks only as digests, and
   candidate/build identities; and
6. repair forward with a separately reviewed migration and candidate.

If isolated staging fails before any accepted evidence exists, restoring the
entire isolated database from its retained snapshot is permissible. Selective
deletion of command or audit evidence is not a production rollback. If a
migration apply is interrupted or returns an unknown outcome, schema and
migration-table readback decide the state before another apply attempt.

## Current local evidence

At this checkpoint:

- Application D1 candidate head is 0076;
- the local SQLite inventory is 76 migrations, 104 required tables, 1,759
  checked incremental columns, and 162 key indexes;
- the 0074/0076 SQLite verifier includes exact-schema and empty-state
  preflight rejection, immutable 0074 file hashing, final schema objects,
  exact protected trigger closure with an unknown-trigger negative,
  passkey generation enforcement, unrelated logs, protected-audit rejection,
  duplicate-rebuild rejection, the 34/37-object 0073 migration-aware profiles,
  22 cross-engine-stable final SQL fingerprints, and three complete table
  PRAGMA fingerprints;
- the typed command's focused Rust derivation tests pass;
- the complete Worker Rust library passes 991 tests, including the private
  0074 repository and route-free coordinator source-contract tests;
- two Bun SQLite coordinator tests prepare the exact phase query against
  migrations 0001 through 0076 and project every authority component plus the
  current terminal ledger head;
- the isolated issuer aggregate passes 29 TypeScript protocol tests and 7
  Workerd runtime tests. Rust and TypeScript consume the same versioned
  39-request/49-subject fixed-vector canary manifest;
- the real-Workerd atomic-admission suite passes 43 tests, including 0076
  generation-greater-than-`iat` exact `5/0`, post-drop migration rollback,
  same-Session readback, privacy projection, ordinary/protected retention,
  replay after passkey deletion, five-second issuance boundaries, exact
  trigger closure, immutability, and generation-drift rollback;
- migration configuration resolves a contiguous 76-migration chain with 0076
  as head; and
- the repository-root `bun run check` aggregate passes across Worker builds,
  Workerd/Vitest contracts, frontend gates, SQLite verification, the complete
  Rust workspace, and all required WASM target checks.

The aggregate `python tools/verify_sqlite.py` gate is green. It replays through
0073 against the 34-object base profile, preserves the historical 0074
profile, and verifies the 37-object exact 0076 profile plus the final 22-object
command and three-table PRAGMA contracts. These are local implementation
facts, not remote staging evidence.

## Remaining gates

### 0074/0076-specific

- Local 0076 implementation, schema fingerprints, post-drop rollback, and
  exact `5/0` pass. Apply 0075/0076 only through a version-controlled isolated
  staging campaign with backup/Time Travel, catalog/PRAGMA readback, injected
  faults, N/N-1 checks, and retained signed evidence. Every remote command
  write remains blocked until that evidence is approved.
- The route-free coordinator foundation is implemented and documented in
  [`relay-container-drain-registration-coordinator.md`](relay-container-drain-registration-coordinator.md).
  It uses one first-primary SQL statement per phase, validates fresh Root,
  session, credential, authorization, fence/head, ledger, and consumption
  state, and pins a semantic authority fingerprint across challenge, issuer,
  and commit phases.
- Wire that foundation only through a private, default-off begin/finish
  protocol after the Service-Binding-only or named-entrypoint caller boundary
  is frozen and tested. No coordinator route exists yet.
- Wire the implemented Application-issued, short-lived
  `RootSessionPhaseProofV1` after every fresh D1 phase snapshot. Rust Cookies
  now carry an exact generation and random `sid`, while neither the Cookie,
  raw `sid`, nor `SESSION_SECRET` may cross the Service Binding. The frozen
  protocol and remaining replay boundary are documented in
  [`root-session-phase-proof-v1.md`](root-session-phase-proof-v1.md).
- The typed challenge, issuer-request, and commit subject structs are frozen
  locally. The typed begin intent also freezes all twelve caller-controlled
  action inputs and issuer validation rejects any later action substitution.
  Commit binding is derived internally from the verified action, frozen
  issuer request, authenticated issuer request ID/version, and opaque verified
  permit; retain these vectors and do not reintroduce a caller-carried digest
  or direct command constructor.
- Use a dedicated persistent coordinator DO. The generic Passkey ceremony and
  generic admin Passkey step-up paths cannot provide response-loss recovery
  while preserving 0074's atomic Passkey consumption.
- Add complete command/alias winner recovery before any
  `OutcomeUnknown` retry, and bind an immutable issuer-auth HMAC key
  ID/version without overloading the permit signing key ID.
- Keep the isolated permit issuer storage-free, private, separately keyed,
  rate limited, and absent from production Application configuration.
- Freeze the environment matrix. The disabled `local` issuer is currently a
  build/test surface only, the Application verifier accepts only `staging`,
  and production deliberately omits issuer authority; no local or production
  end-to-end path may be inferred from the D1 schema.
- Bind a dedicated network-identity HMAC secret only in the private
  coordinator, prove trusted-IP parsing/header provenance, dual-key rotation
  and redaction, bind an immutable non-secret key ID/version, and keep the raw
  IP outside command/audit persistence.
- Exercise concurrent equivalent and conflicting commands, response loss,
  process loss, session expiry, permit expiry, Root revocation, credential
  rotation/deletion, generation and sign-count drift, fence/head drift,
  ledger-head drift, schema drift, and D1 retry behavior.
- Repeat `5/0` and exact readback in remote isolated staging with retained
  before/after schema and Time Travel evidence.
- Add a version-controlled 0075/0076 remote
  backup/preflight/apply/readback/fault-campaign
  command that defaults to read-only, requires explicit mutation confirmation,
  and emits a signed evidence bundle. Ad hoc Wrangler commands are not an
  acceptable production gate.
- Complete credential rotation, secret scanning, trust-pin/HMAC rotation,
  least-privilege Service Binding and Access review, audit retention/legal
  approval, load, duration, cost, SLO, alert, and rollback evidence.

### Broader migration

0074 does not authorize source collection, claim/terminal workers, R2 evidence
retention, drain close, operation 14, traffic return, billing/settlement
ownership, reverse synchronization, DNS or route change, customer traffic, or
Go/VPS retirement. Those milestones retain independent evidence packets and
security, SRE, finance, and release approvals.

Until every 0074-specific and broader gate passes for one immutable candidate,
Go/VPS remains authoritative and Cloudflare production remains **NO-GO**.
