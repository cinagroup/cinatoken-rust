# Drain-Source Registration Coordinator Durable Object V1

## Status

This document freezes the local, route-free durable journal that will
eventually surround the three-phase drain-source registration coordinator.
The implementation is
`crates/worker/src/container_drain_source_registration_coordinator_do.rs`.

Implemented and verified locally:

- deterministic per-operation Durable Object naming;
- exact canonical-JSON `POST` protocol;
- independent current/previous HMAC caller authentication;
- object-name, method, path, request-ID, body, caller, audience, and time
  binding;
- a monotonic registration state machine;
- atomic state, replay-index, and hash-chain event writes;
- exact-request replay and divergent-request conflict handling;
- bounded alarms, precommit expiry, and uncertain-commit recovery;
- redacted status and terminal readback;
- SQLite-backed Workerd concurrency, response-loss, alarm, and eviction tests;
  and
- source/config tests proving that tracked Wrangler configurations have no
  binding, migration, authority variable, or public route for this class.

Not implemented or enabled:

- no Application caller;
- no dedicated route-free coordinator Worker;
- no Service Binding or named entrypoint;
- no browser begin/finish route, CSRF, Origin, or rate-limit integration;
- no Root phase-proof call site;
- no WebAuthn assertion parser or verifier call site;
- no permit-issuer call;
- no D1 0074 command call;
- no command/alias winner-readback adapter;
- no staging binding, secret, migration, deployment, or remote evidence; and
- no production binding, route, authority, or traffic.

The class is exported by the compiled Rust module only so isolated Workerd can
instantiate it. `DRAIN_SOURCE_REGISTRATION_COORDINATORS` exists only in
`vitest.do.config.mjs`. Go/VPS remains authoritative and production remains
**NO-GO**.

## Trust boundary

The Durable Object is a durable operation journal, not global authority.

```text
future private Application caller
  -> authenticated coordinator entrypoint
  -> one deterministically named coordinator DO
  -> phase journal around external awaits
  -> authoritative D1 0074 command
  -> command and alias winner readback
```

D1 remains the linearization point. The object may prove that a challenge,
assertion opportunity, verified proof, issuer request, permit, or command
attempt was already recorded. It may not select a D1 winner or convert an
unknown command outcome into success without authoritative readback.

The current DO fetch adapter is defense in depth for the future route-free
entrypoint. It is not evidence that a public `/internal/*` path is private.
The eventual caller still requires a Service Binding or separately reviewed
named entrypoint with `workers_dev=false`, `preview_urls=false`, and no route.

## Deterministic object name

There is one object per registration operation, not one global Root object and
not a fixed modulo pool.

```text
domain =
  "cinatoken:relay-container:drain-source-registration:coordinator-object:v1"

digest = SHA256(
  domain
  || u32be(len(environment)) || environment
  || u32be(len(root_user_id)) || root_user_id
  || u32be(len(scope_kind)) || scope_kind
  || u32be(len(scope_id_sha256)) || scope_id_sha256
  || u32be(len(operation_id_sha256)) || operation_id_sha256
)

name = "drain-source-registration-coordinator-v1:" || hex(digest)
```

`root_user_id` is a canonical positive decimal string no greater than
`Number.MAX_SAFE_INTEGER`; scope kind is exactly `global`; all identity
digests are lowercase SHA-256. The authorization identity is retained in
state and must remain exact, but it is deliberately not a naming field. A
changed authorization for the same operation collides with the existing
object and fails closed rather than creating a second ceremony.

Every request recomputes this name from typed identity, compares it with the
authenticated authority claim, derives the namespace ID with `id_from_name`,
and compares that ID with `state.id()`.

The Rust fixed vector and independent Bun/WebCrypto runtime agree:

```text
environment = local
root_user_id = 42
scope_kind = global
scope_id_sha256 = cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
operation_id_sha256 = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

name =
drain-source-registration-coordinator-v1:10c65558fe1c42f372391eb1b063c51995a307392f6033bb9eecb567b184c0ce
```

Raw Cookie, `sid`, username, network address, assertion, public key, and secret
material never enter the object name.

## Private caller authority

All capabilities require exact `POST`, no query string, and
`application/json` or `application/json; charset=utf-8`.

| Path | Capability |
|---|---|
| `/v1/begin` | Create one `ChallengeIssued` operation |
| `/v1/finish` | Advance one exact finish phase |
| `/v1/status` | Return redacted durable state |
| `/v1/recover` | Apply an authoritative terminal classification |

Request bodies are streamed and capped at 16 KiB even when
`Content-Length` is absent or false. Responses are capped at 8 KiB and carry
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

Bodies must be canonical JSON:

- valid UTF-8 JSON;
- no BOM, whitespace, duplicate retained key, or alternate key order;
- recursively lexicographic object keys;
- exact typed fields with unknown fields rejected; and
- canonical integer and lowercase digest forms.

The authority header is:

```text
x-cinatoken-drain-source-registration-coordinator-authority:
  BASE64URL(header) "." BASE64URL(claims) "." BASE64URL(HMAC-SHA256)
```

The signing input is:

```text
"cinatoken:relay-container:drain-source-registration:coordinator-authority:v1:"
|| BASE64URL(header)
|| "."
|| BASE64URL(claims)
```

The exact canonical header contains:

```json
{"alg":"HS256","kid":"...","typ":"CINATOKEN-DRAIN-SOURCE-REGISTRATION-COORDINATOR"}
```

The exact canonical claims contain:

| Claim | Required binding |
|---|---|
| `issuer` | configured Application caller issuer |
| `audience` | configured coordinator audience |
| `caller_identity_sha256` | configured stable caller identity |
| `request_id_sha256` | exact request body request ID |
| `method` | exact `POST` |
| `path` | exact capability path with no query |
| `object_name` | deterministic operation object name |
| `body_sha256` | SHA-256 of exact received bytes |
| `issued_at` | integer Unix seconds |
| `expires_at` | integer Unix seconds |

The signature is verified before claims are deserialized. Header, claims, and
signature use canonical unpadded Base64URL. Authority lifetime is at most 30
seconds with at most five seconds of future clock skew.

The local configuration contract is:

```text
DRAIN_SOURCE_REGISTRATION_COORDINATOR_ENVIRONMENT
DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_ISSUER
DRAIN_SOURCE_REGISTRATION_COORDINATOR_AUTHORITY_AUDIENCE
DRAIN_SOURCE_REGISTRATION_COORDINATOR_CALLER_IDENTITY_SHA256
DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_KID
DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_CURRENT_SECRET
DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_KID
DRAIN_SOURCE_REGISTRATION_COORDINATOR_HMAC_PREVIOUS_SECRET
```

The current key is mandatory. The previous key is all-or-none. Key IDs and
secrets must be pairwise distinct across the two slots; secrets are 32 to 256
bytes. Caller identity is stable across rotation and is separately bound into
every signed claim. Only `local` and `staging` are accepted. HMAC bytes in
`staging` are accepted only from Worker Secret bindings; ordinary variable
fallback is restricted to `local` Workerd. These variables exist as fake
values only in the Workerd test configuration. Production configuration must
omit them.

## Persistent state machine

```text
Empty
  -> ChallengeIssued
  -> FinishClaimed
  -> ProofVerified
  -> PermitRequestFrozen
  -> PermitVerified
  -> CommitAttempted
  -> Applied | ExactReplay | Conflict | RecoveryPending
  -> RecoveryPending -> Applied | ExactReplay | Conflict
```

Before `CommitAttempted`, reaching the operation deadline moves the object to
terminal `Expired`. Reaching the deadline after `CommitAttempted` moves it to
`RecoveryPending`, never `Expired`, because D1 may already have committed.
Only an authenticated `/v1/recover` request carrying command-bound
authoritative readback may leave `RecoveryPending`.

The maximum normal event count is eight:

1. challenge issued;
2. finish claimed;
3. proof verified;
4. issuer request frozen;
5. permit verified;
6. commit attempted;
7. immediate outcome or deadline recovery;
8. authoritative recovery outcome.

Every mutation includes `expected_generation`. A stale generation, skipped
phase, changed identity, changed command ID, malformed winner, or terminal
rewrite returns conflict. There is no reset, reopen, generic mutation, SQL,
permit-mint, or secret-read capability.

### Durable evidence by phase

| Phase | Persisted evidence |
|---|---|
| `ChallengeIssued` | authorization fingerprint, begin intent, ceremony ID, challenge-phase proof, challenge digest, deadline |
| `FinishClaimed` | assertion-envelope and finish-claim digests |
| `ProofVerified` | verified Passkey proof, assertion-signature, and Passkey-state-transition digests |
| `PermitRequestFrozen` | exact issuer request, issuer request ID, issuer phase proof, and issuer-auth key-ID digests |
| `PermitVerified` | permit ID, subject, signature envelope, and issuer-version digests |
| `CommitAttempted` | exact command ID, command body, and commit phase proof digests |
| outcome | command ID, optional winner command ID, classification, and readback evidence digest |

The raw assertion is not persisted. Claim is durable before later parsing or
verification. Each later proof is durable before the next external await.

## Storage and atomicity

The object uses the SQLite Durable Object backend through the Workerd binding.
It currently uses the worker-rs storage transaction API, which remains backed
by the configured SQLite object. No constructor performs I/O and no global
mutable request state exists.

Storage keys are:

```text
drain_source_registration_coordinator_state_v1
event:v1:<20-digit generation>
request:v1:<request_id_sha256>
```

One retriable transaction writes:

1. the immutable generation event;
2. the current state snapshot; and
3. the exact-request replay index.

The transaction closure captures only a fixed 16 KiB byte array and scalar
values, so worker-rs may safely retry it. A replay index binds request ID,
path, exact body digest, resulting generation, phase, and event digest.

Events form a domain-separated SHA-256 chain over actor, body/evidence digest,
from/to phase, generation, timestamp, previous event digest, and request ID.
State stores the latest event digest. Every read verifies the latest event
exists and matches the state generation and phase.

An exact request replay returns persisted current evidence with
`replayed=true` and performs no write. Reusing the request ID with any other
path or body is a conflict. A semantically similar request with a different
request ID is not silently merged; generation CAS decides one winner.

## Response-loss and recovery rules

| Loss point | Retry behavior |
|---|---|
| before durable transaction | caller may retry exact signed request |
| after phase transaction, before response | replay index returns persisted phase |
| after assertion claim | assertion opportunity stays burned |
| after issuer request freeze | exact issuer bytes remain frozen; no changed request |
| after permit persistence | same verified permit remains bound |
| after commit-attempt persistence, before D1 response | deadline/status yields `RecoveryPending` |
| after known outcome persistence | status or exact replay returns terminal evidence |

`RecoveryPending` forbids blind 0074 retry, challenge reopening, assertion
reuse, and permit reissue. The future recovery adapter must query the command
ID and every stable 0074 alias in the same first-primary D1 Session, validate
complete immutable projections, and then call `/v1/recover` with exactly one
of:

- `fresh_applied`, with the expected command as winner;
- `exact_replay`, with the expected command as winner; or
- `conflict`, with a distinct winner.

`outcome_unknown` is not accepted by `/v1/recover`. It remains pending.

## Alarm and retention

The challenge deadline is greater than creation time and at most five minutes
later. An alarm remains armed through `PermitVerified` and
`CommitAttempted`. It is deleted for `RecoveryPending` and terminal phases.

Alarm behavior is monotonic:

- precommit deadline -> append `Expired`;
- post-attempt deadline -> append `RecoveryPending`;
- early or duplicate alarm -> no transition; and
- alarm never deletes evidence.

Status synchronously applies an overdue deadline if an alarm was delayed.
Protected evidence retention and legal deletion policy remain open production
gates; this foundation intentionally has no delete/reset endpoint.

## Local verification

The checked-in tests cover:

- Rust object-name and event-genesis fixed vectors;
- the full eight-generation state chain;
- skipped/stale transition rejection;
- precommit expiry and post-attempt recovery;
- independent Bun/WebCrypto object naming and HMAC issuance;
- 32 concurrent exact begin requests with one fresh write;
- exact replay and divergent request-ID reuse;
- current and previous HMAC key acceptance;
- wrong object, stale authority, noncanonical JSON, media type, and body limit;
- discarded response-body replay with every transport stream drained;
- state and event persistence across two explicit object evictions;
- alarm-driven expiry and recovery;
- structured fail-closed response for corrupt durable state;
- event/replay key counts and absence of raw secret markers; and
- complete existing Workerd DO lifecycle regression.

The source/config audit fails if any tracked Wrangler TOML/JSONC file gains the
binding, class migration, or authority prefix. A future staging increment
must intentionally update that contract and replace it with an equally strict
environment matrix rather than weakening the check.

## Promotion gates

The next ordered work is:

1. create the separate route-free coordinator Worker;
2. freeze its Service Binding or named-entrypoint contract;
3. wire Application-issued `RootSessionPhaseProofV1`;
4. wire begin through fresh first-primary D1 validation;
5. wire finish claim before WebAuthn parsing;
6. wire full WebAuthn verification and Passkey generation/count CAS evidence;
7. call the isolated permit issuer with bounded timeout and response body;
8. reread D1 and persist verified permit plus commit attempt;
9. execute one 0074 command and persist its four-state result;
10. implement same-Session command and all-alias recovery;
11. add default-off, route-free isolated-staging bindings and key provisioning;
12. run remote concurrency, revocation, timeout, response/process-loss,
    N/N-1, load, cost, alert, redaction, retention, and rollback campaigns.

No later item compensates for an earlier missing gate. Production remains
**NO-GO**.
