# Relay Container Drain Registration Coordinator

## Status and scope

This document freezes the route-free coordinator foundation that surrounds
the atomic 0074 drain-source registration command.

Implemented locally:

- one `D1Session::first_primary` phase-snapshot query;
- one SQL statement per authority reread;
- exact Root and signed-session checks;
- current Passkey identity, generation, counter, clone, backup, and deletion
  checks;
- authorization, scope-head, admission-fence, ledger-head, and consumption
  checks;
- `before-challenge`, `before-issuer`, and `before-commit` pure validators;
- a semantic authority fingerprint shared by all three phases;
- frozen canonical challenge/issuer/commit subjects reconstructed from typed
  evidence rather than caller-carried digests;
- exact parent-proof chaining and derived phase-binding comparison;
- exact frozen issuer-request and latest-D1-time verified-permit checks;
- phase-specific opaque challenge, issuer, and commit outputs;
- production rejection;
- route-free typed output for the later WebAuthn and command layers; and
- SQLite-schema, projection, and Rust drift-matrix tests.

Not implemented or enabled:

- no HTTP or RPC begin/finish entrypoint;
- no Application-to-issuer Service Binding;
- no Access policy or private-caller proof;
- no coordinator enable flag;
- no remote D1 read or write;
- no issuer call;
- no 0074 command call from a route;
- no local, staging, or production deployment change; and
- no traffic, DNS, source collection, or Go/VPS authority change.

Go/VPS remains authoritative and production remains **NO-GO**.

## Authority model

D1 is the only global authority. A Durable Object may hold and consume one
short-lived ceremony, but it may not decide the globally unique winner.

```text
signed Root session
  -> one first-primary D1 phase snapshot
  -> route-free authority validation
  -> action-bound one-shot Passkey ceremony
  -> fresh first-primary D1 phase snapshot
  -> private storage-free permit issuer
  -> fresh first-primary D1 phase snapshot
  -> one atomic 0074 INSERT
  -> exact same-Session five-part readback
```

The final 0074 `INSERT`, not the Worker, Durable Object, or issuer, is the
linearization point. A fresh command has exactly five effects and an exact
replay has zero.

## Root session requirements

The future caller must supply a session that has already passed signed-cookie
authentication. The coordinator then requires:

- a positive Root user ID;
- exact role `100`, not merely an Admin role;
- enabled status and no deletion timestamp;
- an exact match between the signed Cookie `session_epoch` and current D1
  `session_epoch`;
- a canonical random per-issue Cookie `sid`;
- D1 time within `[session_iat, session_exp)`;
- canonical 64-character lowercase Cookie-binding and session-ID digests; and
- authorization ownership by that same Root ID.

An API key, bearer token, `New-Api-User`, caller-carried role, or cached user
row is not sufficient. The future entrypoint must reject bearer-based use
before invoking this module.

`crates/root-session-phase-proof` now implements the route-free
`RootSessionPhaseProofV1` issue/verify protocol. Application remains the
session authority and mints a short-lived, authorization-, operation-,
session-, phase-, and semantic-authority-bound proof after each fresh D1
Root/session check. The coordinator accepts only the opaque verified type,
not caller-carried claims. The proof includes non-secret signing key
ID/version metadata and never exposes the Cookie, raw `sid`, or
`SESSION_SECRET`. See
[`root-session-phase-proof-v1.md`](root-session-phase-proof-v1.md).

The runtime coordinator treats `session_epoch` only as a generation.
Immutable 0074 retains its historical predicates byte-for-byte. Additive 0076
locally verifies the exact predecessor schema and empty command/consumption
state, rebuilds the effective command table and trigger closure without those
predicates, and passes SQLite/Workerd fingerprint, post-drop rollback, and
generation-greater-than-`iat` `5/0` tests. This closes the local schema
blocker. The typed phase-subject and verified-permit consumption blockers are
also closed locally, but the coordinator still cannot be wired to a writer
until private transport, persistent replay recovery, staging keys, and remote
D1 evidence are complete.

## One-statement phase snapshot

`relay_container_drain_source_registration_phase_snapshot` accepts only:

1. the authorization ID digest; and
2. the already authenticated Root user ID.

It does not accept a caller-selected Passkey row, fence, scope head, receipt
sequence, or ledger predecessor. One active Passkey is selected through the
Root ownership join.

The single SQL statement projects:

- the immutable 0072 authorization;
- the matched Root role, status, epoch, and deletion state;
- the current Root Passkey row, encoded credential and public key, three
  immutable credential digests, use generation, sign count, clone and backup
  state, update time, and deletion state;
- the current global scope head;
- the current admission fence;
- the latest global receipt-ledger row;
- the complete ledger count;
- current-authorization command, registration, claim, terminal, and source
  scan counts; and
- D1 `unixepoch()`.

After the query, the Session bookmark is immediately reduced to SHA-256. The
opaque bookmark is never returned or persisted.

The bookmark is evidence of a successful first-primary read. It is not a
transaction token, an authority identity, or a requirement that later phase
reads return the same bookmark.

## Passkey identity rule

The D1 `credential_id_sha256` column is not a plain SHA-256 of credential
bytes. It uses the registration domain and length-prefixed input:

```text
domain = "cinatoken:passkey:credential-id:v1"
digest = SHA256(domain || u64_be(length) || credential_id)
```

The coordinator and ceremony now reuse the same helper used when the
credential is registered. Plain SHA-256 is rejected. This closes a mismatch
that unit fixtures previously hid and prevents valid D1 credentials from
being rejected at the registration ceremony.

The phase validator also requires:

- the Passkey belongs to the same Root;
- the row is active and not clone-warned;
- registration, credential-ID, and binding digests are present, canonical,
  and pairwise distinct;
- decoded stored credential and public-key bytes are bounded;
- the recomputed domain-separated credential-ID digest matches D1;
- generation is in
  `0..=Number.MAX_SAFE_INTEGER - 1`;
- sign count fits unsigned 32-bit WebAuthn semantics; and
- every stored boolean is exactly zero or one.

The later WebAuthn verifier remains responsible for parsing the COSE public
key and verifying challenge, RP ID, HTTPS Origin, signature, UP, UV,
userHandle, backup flags, clone state, and sign-count transition.

## Fence and ledger rules

The phase is eligible only when:

- the current scope-head environment, kind, and ID match authorization;
- current fence ID and generation match authorization;
- head version and digest match authorization;
- the joined fence is kind `admission`;
- the fence is open and has no close timestamp;
- fence environment, scope, generation, and state digest match; and
- no command, registration, claim, terminal, or source scan exists for the
  current authorization.

Receipt derivation is closed:

- an empty global ledger yields sequence `1` and the authorization's expected
  head digest;
- otherwise the latest row must be the current contiguous ledger sequence and
  event kind `terminal`;
- the next sequence is `latest + 1`; and
- the predecessor is the latest terminal receipt digest.

A latest `registration` or `claim`, a gap, a malformed digest, a future
recorded time, or a row for the current already-consumed authorization fails
closed.

## Three-phase validation

### Before challenge

The first validator accepts a validated
`DrainSourceRegistrationBeginIntentV1`, not loose operation or RP/Origin
strings. The intent binds staging, operation, authorization, ceremony,
request intent, RP ID, HTTPS Origin, D1 issue time, and all twelve
caller-controlled action inputs: action/request/audit digests, keyed network
identity HMAC, ticket, reason, verification expiry, writer service/version,
execution ID, credential ID, and ceremony nonce. The validator checks the
live authority, reconstructs the canonical before-challenge subject from that
intent plus D1-verified authorization subject/envelope digests, derives the
phase binding, and returns an opaque
`ValidatedDrainSourceRegistrationChallenge`.

That output carries:

- verified authorization fields;
- decoded current Passkey material;
- current receipt sequence and predecessor;
- D1 time; and
- a semantic authority fingerprint.

The later begin route must use only these returned authority fields when it
constructs `DrainSourceRegistrationActionV1` and must use the retained RP ID,
Origin, and issue time when it creates the ceremony.

### Before issuer

After one-shot ceremony consumption and complete WebAuthn verification, the
future finish route must reread D1 and call `validate_before_issuer` with the
opaque challenge output, exact ceremony, and
`VerifiedDrainSourceRegistrationPasskeyProof`.

The validator requires:

- the signed parent digest equals the complete verified challenge proof;
- the semantic fingerprint equals the before-challenge fingerprint;
- ceremony RP ID, Origin, and issue time equal the typed begin intent;
- every caller-controlled action input equals the value frozen before the
  challenge;
- every authority-bearing action field equals the fresh D1 projection;
- Root session ID, epoch, iat, exp, and binding still match;
- Passkey row and immutable identities still match;
- generation and sign count have not moved;
- receipt sequence and predecessor have not moved; and
- D1 time is still before session, authorization, and verification expiry;
- the exact 39-field request is generated only from ceremony plus verified
  Passkey evidence; and
- the canonical issuer subject binding equals the signed claim.

No issuer request is allowed after a mismatch. The successful opaque
`ValidatedDrainSourceRegistrationIssuer` owns the frozen request bytes used
for the isolated issuer call and the next phase.

### Before commit

After a permit is returned and cryptographically verified, the future finish
route must reread D1 again and call `validate_before_commit` with the opaque
issuer output and `VerifiedDrainSourceRegistrationPermit`.

It applies the same complete checks, requires the signed parent to be the
complete verified issuer proof, compares the permit's reconstructed 39-field
request with the frozen request byte for byte, and rechecks permit validity at
the latest D1 time. It then binds the action, request, authenticated request-ID
digest, issuer version, permit ID, permit subject, and permit
signature-envelope digest into the canonical commit subject.

Only `ValidatedDrainSourceRegistrationCommit` may feed
`VerifiedDrainSourceRegistrationCommand::from_validated_commit` and the 0074
repository. The old action/proof/permit constructor is no longer exposed, so
a caller cannot bypass the fresh before-commit D1 validation.

The 0074 trigger repeats the live Root, Passkey, authorization, fence, ledger,
and consumption checks inside the atomic statement. The coordinator is an
early fail-closed layer, not a replacement for D1 guards.

## Semantic fingerprint

The fingerprint is a domain-separated SHA-256 over deterministic JSON
containing:

- the full authorization row;
- Root authority state;
- the full current Passkey authority state, including encoded credential and
  public key;
- scope head and fence;
- latest ledger row and ledger count;
- all current-authorization consumption counts; and
- derived receipt sequence and predecessor.

It deliberately excludes:

- D1 time; and
- the first-primary bookmark digest.

Time is checked independently at every phase. Bookmark changes are expected
as D1 advances. Every authority-bearing mutation changes the fingerprint or
fails a direct invariant first.

## Failure classes

The route-free module exposes stable internal classes:

| Class | Meaning |
|---|---|
| `InvalidInput` | Caller supplied a malformed expected identity or phase combination |
| `UnsupportedEnvironment` | Anything other than the current staging-only contract |
| `AuthorizationStateChanged` | 0072 row missing, malformed, mismatched, or replaced |
| `RootStateChanged` | Root missing, disabled, deleted, demoted, or not exact Root |
| `SessionStateChanged` | Epoch, iat, exp, or live D1 time no longer authorizes use |
| `PasskeyStateChanged` | Owner, row, identity, generation, count, clone, backup, or deletion drift |
| `FenceStateChanged` | Scope head or admission fence is not the exact open authority |
| `LedgerStateChanged` | No exact current terminal ledger predecessor exists |
| `AuthorizationAlreadyConsumed` | Command, registration, claim, terminal, or scan already exists |
| `AuthorityExpired` | Authorization is not live at D1 time |
| `AuthorityDrift` | Semantic fingerprint changed across phases |
| `ActionMismatch` | Frozen action no longer equals fresh authority/session state |
| `CeremonyMismatch` | Begin intent, ceremony, challenge, action, or verified Passkey evidence diverged |
| `PhaseChainMismatch` | Parent proof is absent, stale, or skips a phase |
| `PhaseBindingMismatch` | Signed claim does not equal the internally derived typed subject binding |
| `PermitMismatch` | Verified permit does not reproduce the exact frozen issuer request |
| `PermitExpired` | Permit or phase authority is not live at the latest D1 time |

The future external API must collapse sensitive distinctions. It must not
reveal whether a Passkey is absent, malformed, deleted, or signature-invalid.

## Durable Object boundary

The generic `PasskeyCeremony` object proves put-once/take-once semantics, but
it is not sufficient for 0074. Its successful take deletes the claim before
the response is durably recoverable. If that response is lost, a retry sees
only an expired/consumed result. The generic admin Passkey finish path also
updates Passkey state before writing a KV step-up marker, which would violate
0074's five-effect atomic consumption.

0074 therefore requires a dedicated coordinator Durable Object with a
persistent SQLite state machine:

```text
Empty
  -> ChallengeIssued
  -> FinishClaimed
  -> ProofVerified
  -> PermitRequestFrozen
  -> PermitVerified
  -> CommitAttempted
  -> Applied | ExactReplay | Conflict | RecoveryPending
```

`RecoveryPending` may advance only through authoritative command and alias
winner readback. It may never reopen the challenge, call the issuer again, or
blindly replay the 0074 insert.

Required behavior:

- deterministic, versioned naming from environment, Root, global scope, and
  operation identity, never fixed modulo pools or one global Root object;
- begin creates `ChallengeIssued` once;
- finish persists `FinishClaimed` before parsing or verifying the assertion;
- every failed finish burns the assertion opportunity;
- proof, frozen issuer request, verified permit, and commit attempt each
  become durable before the next external await;
- response-loss retries return persisted terminal evidence;
- expiration is bounded by action, session, and authorization lifetime;
- raw Cookie, token, IP, assertion, private credential, and issuer secret are
  never retained; and
- Durable Object state never advances D1 authority.

## Private transport requirements

Before any route is added, the Application caller boundary must prove:

- a private Service Binding or named entrypoint that cannot be reached by the
  public router;
- an independently authenticated caller identity;
- exact `POST` method and media type;
- bounded request and response bodies;
- CSRF and fixed HTTPS Origin checks for browser-facing begin/finish;
- rejection of bearer/API-token authentication;
- per-Root and network-pseudonym rate limits;
- bounded issuer timeout and response size;
- no automatic retry after assertion consumption;
- no secrets in request logs or exception strings; and
- a default-off staging gate absent from production configuration.

An ordinary `/internal/*` path plus a shared header is not enough evidence of
Service-Binding-only reachability.

The current main Worker routes `/internal/*` through its public fetch router.
The coordinator must instead be a separate Worker with no route,
`workers_dev`, or preview URL, reached only through an explicitly granted
Service Binding or separately verified named entrypoint. Under the current
worker-rs version, an exact bounded `Fetcher` protocol with independent HMAC
caller authentication is the conservative baseline; adopting typed RPC must
be proven in a separate compatibility increment.

Only minimal capabilities may be public on the private entrypoint or DO:
`begin`, `finish`, `status`, and `recover`. Generic SQL execution, reset,
permit minting, and secret-access methods are forbidden.

## Environment matrix

| Environment | Coordinator | Permit issuer | 0074 write |
|---|---|---|---|
| local | Route absent; pure tests only | Disabled build/test surface | Disabled |
| isolated staging | Future default-off private entrypoint | Future private Service Binding | Future explicit fault campaign only |
| production | Absent | Absent | Disabled |

Production configuration must omit issuer authority, not carry a false
placeholder that can later be toggled accidentally.

## Test and fault matrix

Local implemented coverage includes:

- exact three-phase validation;
- time and bookmark changes preserving semantic fingerprint;
- Root role, status, deletion, and epoch drift;
- session expiry and binding drift;
- Passkey generation, sign-count, digest, public-key, clone, and deletion
  drift;
- head and fence drift;
- every current-authorization consumption count;
- empty and terminal global ledger derivation;
- nonterminal ledger rejection;
- authorization expiry and production rejection;
- domain-separated credential-ID regression;
- source-contract proof of one first-primary, one statement, and no writes;
- exact SQL prepare against migrations 0001 through 0075;
- fixture projection of every nested authority component and terminal ledger
  head;
- strict signed phase proof issue/verify, canonical encoding, current/previous
  rotation, exact session anchoring, and parent-chain coverage;
- the 22-field typed begin intent with explicit `u32be` framing plus all three
  typed canonical phase subjects and bindings in independent Rust and
  Bun/WebCrypto fixed vectors;
- rejection when a freshly signed issuer phase tries to pair a retained
  challenge with a different otherwise-valid action intent;
- exact frozen issuer-request and permit mismatch/expiry negatives; and
- command assembly through only the opaque validated commit.

Still required before staging enablement:

- Application issuance wiring and private transport key provisioning for the
  implemented `RootSessionPhaseProofV1` protocol;
- dedicated recoverable coordinator DO and its persistent transition log;
- full winner recovery by command ID and every stable 0074 alias;
- immutable issuer-auth HMAC key ID/version evidence, likely through an
  additive migration rather than overloading the permit signing key ID;
- concurrent equivalent and conflicting begin calls;
- concurrent finish and one-shot consumption;
- Root/session/Passkey/fence/ledger drift injected at all three boundaries;
- malformed WebAuthn and every UP/UV/Origin/RP/signature failure;
- authenticator `0 -> 0`, strict increment, rollback, and concurrent CAS;
- issuer timeout, oversized response, identity, version, key, signature,
  envelope, and five-second-boundary failures;
- response loss before and after the 0074 insert;
- exact `5/0` remote D1 evidence;
- partial readback and unknown `meta.changes`;
- no raw IP, username, Cookie, token, assertion, or public key in logs;
- protected-audit retention;
- credential and trust rotation;
- load, duration, cost, SLO, alert, and rollback rehearsal; and
- independent security, SRE, privacy/legal, and release approval.

## Next implementation boundary

The next code increment is not a public route and not a production gate. It
must:

1. freeze the private caller protocol;
2. wire the implemented Application-issued Root session phase proof only
   behind that private boundary;
3. implement the dedicated durable coordinator state machine and alias-winner
   recovery without any public route;
4. choose and test the Service-Binding-only or named-entrypoint boundary;
5. add default-off staging configuration while keeping production authority
   absent;
6. wire begin to the first phase snapshot and durable `ChallengeIssued`;
7. wire finish through durable claim, WebAuthn verification, issuer reread/call,
   final reread, and 0074 command;
8. preserve the four-state
   `FreshApplied`/`ExactReplay`/`Conflict`/`OutcomeUnknown` result model; and
9. add a version-controlled isolated-staging 0075/0076
    backup/apply/readback/fault campaign before any remote mutation is
    attempted.

Until those gates and the broader migration gates pass, Cloudflare production
remains **NO-GO**.
