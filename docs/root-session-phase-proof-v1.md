# RootSessionPhaseProofV1

Date: 2026-07-31

Status: frozen route-free protocol with typed three-phase subjects, local
coordinator integration, and a default-off staging Application signer. It is implemented in
`crates/root-session-phase-proof`; the pure drain-source registration
coordinator independently reconstructs every subject from typed evidence and
compares the derived binding with the signed claim. It is not wired to a
public route, complete browser call chain, remote D1 database, or production
secret. Production remains **NO-GO**.

## Purpose And Trust Boundary

The browser session Cookie terminates at the Application Worker. The
Application:

1. verifies the Rust session Cookie;
2. rereads the exact live Root row and current D1 session generation;
3. takes the one-statement phase authority snapshot;
4. derives privacy-preserving bindings; and
5. signs a short-lived phase proof with a dedicated HMAC key.

The private coordinator receives the proof, not the Cookie or
`SESSION_SECRET`. It accepts authority only through the opaque
`VerifiedRootSessionPhaseProof` returned after strict signature and claim
verification.

The Application runtime now has a route-free before-challenge signer candidate.
It first validates the exact one-statement authority snapshot and derives the
semantic fingerprint, then signs and immediately verifies the typed subject.
Its current secret is read only from a staging Worker Secret, key metadata is
non-secret, and `CF_VERSION_METADATA` supplies the exact Application version.
Both Application begin and coordinator client gates remain false, production
contains no capability, and no browser handler calls this path.

The route-free Application assembly now derives the proof subject from one
exact D1 snapshot and a redacted live Root-session anchor. The anchor hashes
the canonical 32-byte session ID and separately hashes the Root ID, live role,
status, session epoch, issue/expiry times, and session ID under distinct
length-framed domains. It retains neither Cookie nor raw `sid`. The resulting
proof is frozen into the same Application checkpoint as the exact action,
challenge, begin intent, and deterministic coordinator request.

This protocol does not make the proof single-use. A dedicated coordinator
Durable Object must persist the operation and phase transition before any
staging route can be enabled.

## Session Authority

Rust session cookies now carry three independent time/revocation facts:

- `session_epoch`: the exact monotonic D1 revocation generation;
- `sid`: a fresh canonical Base64URL identifier from 32 random bytes on every
  issue; and
- `iat`/`exp`: the cookie lifetime.

The live D1 row must have `session_epoch == cookie.session_epoch`. It is not a
Unix timestamp and must never be compared to `iat`. Multiple revocations in
one second therefore remain distinguishable. Legacy Rust cookies without a
valid `sid` and exact generation fail closed and require reauthentication.

Migration `0075_root_authority_exactness.sql` additionally:

- restricts roles to `0`, `1`, `10`, or exact Root `100`;
- requires session generations in `0..=Number.MAX_SAFE_INTEGER`;
- prevents generation rollback; and
- rechecks exact role `100`, enabled status, no deletion, and exact generation
  at both final drain-source registration write boundaries.

Password changes and resets, role changes, disable, and soft delete update the
account and increment its generation in one D1 statement.

The Application, action, permit, issuer, and phase-proof runtime contracts no
longer compare this generation with a timestamp. Immutable migration 0074
still contains the historical predicates in its migration text and remains
byte-stable. Migration 0076 locally verifies the exact 0074/0075 predecessor
schema and empty command/consumption projections, rebuilds the effective table
and trigger closure without those predicates, and refreezes every normalized
SQL/PRAGMA fingerprint. SQLite and Workerd cover failed preflight,
post-drop rollback, and an exact generation-greater-than-`iat` `5/0` commit.
Remote D1 apply and readback remain absent.

## Wire Format

The proof has exactly three canonical unpadded Base64URL segments:

```text
base64url(protected_json) "." base64url(claims_json) "." base64url(signature)
```

It resembles a compact JWS but is a dedicated protocol. Generic JWT/JWS
libraries must not infer its signing input or claim semantics.

The protected header is exactly:

```json
{
  "typ": "CINATOKEN-ROOT-SESSION-PHASE-PROOF",
  "alg": "HS256",
  "kid": "<lowercase key id>",
  "key_version": 1
}
```

The signature is:

```text
HMAC-SHA256(
  key,
  "cinatoken-root-session-phase-proof:v1\0"
  || u64be(len(protected_segment)) || protected_segment
  || u64be(len(claims_segment)) || claims_segment
)
```

Every Base64URL segment must be canonical and unpadded. Header and claim JSON
must byte-match serialization of the frozen structs in declared field order;
unknown fields, alternate field order, whitespace, duplicate representation,
or a noncanonical segment fail closed. Claims are deserialized only after the
signature succeeds.

Limits are:

| Item | Limit |
|---|---:|
| HMAC key | at least 32 bytes |
| protected JSON | 512 bytes |
| claims JSON | 6,144 bytes |
| complete token | 8,192 bytes |
| default proof TTL | 10 seconds |
| maximum proof TTL | 15 seconds |

## Bound Claims

The frozen claims bind:

- protocol version, issuer, audience, Application version, and staging
  environment;
- exact phase, private method, and private begin/finish path;
- operation, global scope, authorization, ceremony, request intent, and proof
  identifiers;
- exact Root ID, role `100`, status `1`, and `deleted_at = null`;
- exact session generation, iat, exp, Cookie binding digest, and session-ID
  digest;
- D1 observation time and phase authority expiry;
- prior proof digest for later phases;
- phase-specific canonical subject digest; and
- the complete semantic D1 authority fingerprint.

All digests are 64 lowercase hexadecimal characters and are pairwise distinct
inside one proof. This catches accidental field reuse as well as ordinary
claim drift.

V1 freezes three canonical phase-subject structs. Every subject starts with
the same ordered fields:

```text
schema_version, contract, phase, environment, operation_id_sha256,
scope_kind, scope_id_sha256, authorization_id_sha256,
ceremony_id_sha256, request_intent_sha256,
semantic_authority_fingerprint_sha256
```

The phase-specific suffix is:

| Phase | Typed evidence |
|---|---|
| `before_challenge` | begin-intent digest, verified authorization subject digest, verified authorization signature-envelope digest |
| `before_issuer` | verified challenge digest, canonical action-subject digest, exact 39-field permit-issue-request digest |
| `before_commit` | canonical action-subject digest, the same frozen issuer-request digest, authenticated issuer-request-ID digest, issuer version, verified permit ID, subject, and signature-envelope digests |

The begin intent is a real validated type. It binds staging environment,
operation, authorization, ceremony, request intent, canonical RP ID, HTTPS
Origin, and D1 issue time. It also freezes every caller-controlled action
input: action, registration-request, and admin-audit digests; keyed network
identity HMAC; change ticket; reason; verification expiry; writer service and
version; registration execution and credential IDs; and ceremony nonce. The
issuer phase rejects the ceremony before any request is emitted unless all
of those values equal the retained begin intent.

Begin-intent framing is explicitly:

```text
"cinatoken-relay-container-drain-source-registration-begin-intent-v1"
|| u32be(len(field_1)) || field_1 || ... || u32be(len(field_22)) || field_22
```

The exact permit issue request is likewise an opaque canonical type and uses
`cinatoken-relay-container-drain-source-registration-permit-issue-request-v1`.
These action-layer contracts use `u32be`; Root phase-subject, proof-signing,
and token-digest framing use their separately frozen NUL-terminated domains
and `u64be`. Their helpers are intentionally separate.

`phase_binding_sha256` is always recomputed from the phase name and exact
canonical subject JSON under the frozen root-session phase-binding domain.
The coordinator accepts no caller-carried binding or semantic digest. Commit
cannot be validated without consuming the opaque verified permit, checking
that it matches the frozen request byte for byte, and rechecking permit
validity at the latest D1 time.

`issued_at` and `not_before` equal the authoritative D1 observation time.
`expires_at` is the minimum of:

```text
D1 observed time + requested TTL
session expiration
phase authority expiration
```

The resulting expiration must remain strictly after the D1 observation time.
Verification requires the expected current time in
`[not_before, expires_at)`.

## Three-Phase Chain

The only valid order is:

```text
before_challenge -> before_issuer -> before_commit
```

`before_challenge` has no parent. Each later proof carries the
domain-separated digest of the complete verified preceding token. Later
phases must also match the exact session anchor captured at begin:

```text
session_epoch
session_iat
session_exp
session_binding_sha256
session_id_sha256
```

Every phase independently binds the same operation, authorization, ceremony,
request intent, Root ID, and semantic authority fingerprint. Fresh D1
snapshots must still be taken before challenge creation, permit issuance, and
the final 0074 command.

The proof token digest used as `parent_proof_sha256` is:

```text
SHA256(
  "cinatoken-root-session-phase-proof:token:v1\0"
  || u64be(len(token)) || token
)
```

Session binding, session ID, request intent, phase binding, ceremony ID,
operation ID, and proof ID each use a separate protocol domain and
length-prefixed input.

## Key Rotation

Verification accepts exactly one current key and optionally one previous key.
Both have immutable non-secret `kid` and numeric `key_version` metadata.

The key ring is invalid unless:

- both secrets are at least 32 bytes;
- current and previous key IDs differ;
- the previous version is lower than the current version; and
- current and previous secrets differ.

Rotation order for isolated staging is:

1. provision the new secret without logging or persisting it;
2. deploy verifiers with new current plus old previous;
3. deploy issuers using only the new current key;
4. wait beyond the maximum proof TTL plus measured deployment propagation;
5. prove no old-key verification remains; and
6. remove the previous key.

Production configuration must continue to omit this authority until all
production gates are approved.

## Privacy And Logging

The following must never cross the private binding or enter logs, D1 command
rows, audit details, metrics labels, traces, or evidence bundles:

- raw Cookie or `SESSION_SECRET`;
- raw `sid`;
- username;
- raw IP or forwarding headers;
- WebAuthn assertion or public key; and
- proof signing secret.

Only bounded domain-separated digests and non-secret key metadata may cross
the boundary. Error responses use stable codes and must not echo proof bytes.

## Verification

The version-controlled fixture
`tests/fixtures/root-session-phase-proof-v1.json` freezes the 22-field typed
begin intent with its `u32be` framing, all three canonical phase subjects and
bindings, and the complete before-commit protected/claim field order,
signature bytes, and token digest. Rust and an independent Bun/WebCrypto
implementation must both pass:

```powershell
bun run check:root-session-phase-proof
```

Coverage includes canonical encoding, tamper rejection, wrong and rotated
keys, exact session matching, phase and parent drift, Root state, D1 time,
TTL ceilings, application version drift, digest separation, and the exact
three-phase chain.

## Remaining Production Gates

Before isolated staging enablement:

1. apply 0075/0076 only to isolated staging after backup, then retain exact
   catalog/PRAGMA readback, rollback-fault, and `5/0` evidence;
2. wire the implemented live-session/snapshot/action/begin/proof assembly to a
   bounded request adapter after exact Root/Origin/RPID/CSRF/rate-limit checks;
3. add a private Service-Binding-only or named-entrypoint transport with its
   own authenticated caller protocol;
4. prove the private caller protocol carries only the typed inputs required
   by the implemented coordinator and cannot substitute a raw digest;
5. implement the dedicated operation Durable Object with single-use phase
   transitions and response-loss recovery;
6. recover winners by command ID and every stable 0074 alias before retry;
7. provision and rehearse current/previous proof-key rotation;
8. run concurrency, replay, timeout, expiry, revocation, deployment-drift,
   and redaction campaigns;
9. retain remote D1 `5/0` evidence and signed staging artifacts; and
10. obtain security, SRE, privacy/legal, and release approval.

Proof validity alone is never authorization to retry a mutation. The final D1
statement remains the linearization point, and unknown outcomes remain
`OutcomeUnknown` until authoritative readback classifies them.
