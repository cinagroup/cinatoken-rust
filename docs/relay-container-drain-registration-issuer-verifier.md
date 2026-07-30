# Relay Container Drain Registration Issuer And Verifier

Date: 2026-07-30

Status: normative M1 security specification and local implementation
checkpoint. The action-bound WebAuthn foundation, isolated default-off issuer,
Application verifier, cross-language vector, configuration audit, and Workerd
runtime tests are present locally. The private begin/finish coordinator,
migration 0074 writer, registration repository connection, isolated-staging
deployment, and all production deployment are outside this checkpoint.
Go/VPS remains the authoritative production system and production remains
**NO-GO**.

## 1. Purpose And Normative Language

Registering a relay-container drain source changes the authoritative evidence
boundary used by later collection and migration work. Root authentication,
direct D1 access, a syntactically valid 0073 row, a generic secure-verification
marker, or possession of a Service Binding is insufficient authorization.

This document defines the narrow M1 capability that may eventually authorize
one exact drain-source registration in isolated staging. It separates:

1. the upstream drain-source authorization;
2. the typed registration action and verified WebAuthn proof;
3. the non-trusted issuance request;
4. the isolated Ed25519 permit issuer;
5. the Application-side Rust permit verifier; and
6. the future 0074 atomic writer.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative. A
component is not complete merely because its types or configuration files
exist. Completion requires the tests and deployment evidence identified in
this document.

This v1 contract is intentionally limited to `local` development and isolated
`staging`. It does not authorize:

- source collection, claim, terminal, seal, close, reopen, or traffic return;
- billing, settlement, DNS, route, or customer-traffic changes;
- container, deployment, R2 evidence, D1 migration, or schema authority;
- Go/VPS retirement; or
- any production registration or production permit issuance.

## 2. Trust Boundaries

### 2.1 Upstream authorization

`VerifiedDrainSourceAuthorization` is the typed result of the existing
upstream authorization verifier. It binds the accepted-source contract,
environment, source scope, fence and generation, expected ledger head,
collector identity, schema, execution nonce, permit lifetime, signer trust,
and authorizing Root identity.

The registration flow MUST consume this verified type. It MUST NOT reinterpret
an upstream authorization JSON object, accept its digests from the browser, or
rename the upstream permit into a registration permit. The upstream permit has
a different purpose and cannot authorize registration by itself.

### 2.2 Typed action and WebAuthn proof

`DrainSourceRegistrationActionV1` commits the upstream authorization plus the
exact registration request, dedicated protected-audit projection, change
ticket, Root session, passkey credential, registration service/version/
execution identity, current authority ledger state, verification expiry,
origin, RP ID, and one ceremony nonce.

The challenge is action-bound and requires WebAuthn user verification. The
verified proof MUST come from cryptographic verification of the exact
`authenticatorData || SHA256(clientDataJSON)` subject. It MUST include:

- the credential row and credential-ID digest;
- assertion-subject, assertion-signature, and challenge digests;
- the credential row's previous signature count;
- the assertion's new signature count;
- user-presence and user-verification flags;
- backup-eligibility and backup-state flags; and
- the Application-assigned verification time.

`preferred`, `discouraged`, user-presence-only, TOTP, recovery codes, a generic
step-up timestamp, or a reusable session marker cannot satisfy this boundary.
Raw assertion bytes, client data, authenticator data, challenge, session
cookie, private key, and HMAC secret MUST NOT enter the permit subject, D1,
logs, or response diagnostics.

### 2.3 Non-trusted issuance request

`RegistrationPermitRequestV1` is a transport object, not a verified
authorization type. Even when it arrives through a Service Binding, every
field remains non-trusted until:

1. the request HMAC authenticates the Application identity and exact body;
2. the issuer validates the exact request schema, shape, environment, action,
   count transition, and time window;
3. the issuer signs the resulting permit;
4. the Application verifier checks the signature, trust pins, all expected
   typed bindings, request identity, and time window; and
5. the future 0074 statement rechecks live D1 state and atomically consumes the
   permit.

Only the Application may build this request, and only from the typed action
and verified WebAuthn proof. Browser-supplied hashes MUST be recomputed from
the canonical server-side artifacts before entering the typed action.

### 2.4 Isolated issuer

The issuer owns one dedicated Ed25519 signing identity and one exact permit
audience. It authenticates one exact Application request, issues a short-lived
registration-only capability, self-verifies the signature, and returns the
envelope.

The issuer does not read D1 and does not independently know whether a Root
session, credential, fence, ledger head, or assertion is current. Its HMAC
verification proves that the authorized Application attested to the exact
body; it does not turn Service Binding transport or caller assertions into
semantic proof.

The issuer MUST have no D1, KV, R2, Queue, Durable Object, Container, asset,
browser/public route, collector, claim, terminal, close, reopen, traffic,
deployment, or production authority.

### 2.5 Application Rust verifier

The Application owns only public trust pins and verification code. It MUST NOT
contain an Ed25519 signing function, PKCS8 private key, issuer secret loader,
or a way for callers to construct
`VerifiedDrainSourceRegistrationPermit`.

The verifier receives:

- the exact issuer response bytes;
- a typed `DrainSourceRegistrationPermitBindings` projection;
- the Application-held request ID used in the HMAC attestation;
- the current verification time; and
- one complete, deployment-pinned issuer trust tuple.

Only after all checks pass may it return an opaque verified type carrying the
private subject plus server-derived subject and signature-envelope digests.

### 2.6 Future 0074 writer

The future writer is the sole permit consumer. It MUST accept an opaque
`VerifiedDrainSourceRegistrationPermit`, typed action/proof state, and fresh
D1 snapshots. It MUST NOT accept a caller-provided permit ID, subject digest,
signature-envelope digest, secure-verification receipt, audit row, or
credential count transition as authoritative input.

The writer is not present in this checkpoint. No registration route or
repository may be connected before its migration, Workerd matrix, exact
readback, and isolated-staging evidence pass.

## 3. Fixed V1 Scope

The permit subject uses these fixed values:

```text
schemaVersion = 1
contract = "relay-container-drain-source-registration-permit-v1"
environment = "staging"
action = "relay_container.drain_source_authorization_register"
algorithm = "Ed25519"
```

Local tests MAY use `environment="local"` with a separate local issuer,
audience, HMAC credential, Ed25519 key, and Application trust tuple. A local
identity or key MUST never be accepted by staging. The Rust staging verifier
MUST reject `local` and every other environment.

The staging audience is:

```text
cinatoken-relay-application:staging:drain-source-registration:v1
```

The local audience, when used, is:

```text
cinatoken-relay-application:local:drain-source-registration:v1
```

Audience is part of both the signed subject and the signature-envelope digest.
An upstream authorization audience, collector audience, placement audience,
ring-transition audience, local audience, or production-looking audience MUST
not verify under this contract.

## 4. Non-Trusted Issuance Request

### 4.1 Exact body

The request is:

```text
POST /internal/v1/drain-source-registration/permits
Content-Type: application/json
```

Query parameters are forbidden. The body MUST be strict UTF-8 without a BOM,
MUST be no larger than 16 KiB, and MUST be byte-for-byte canonical JSON:

- exactly one top-level object;
- no duplicate, unknown, or missing keys;
- recursively sorted object keys;
- arrays retain their supplied order;
- no insignificant whitespace;
- finite safe integers only;
- booleans serialized as lowercase JSON `true` or `false`; and
- all contract identifiers and digests constrained by their field validators.

The body contains exactly these 33 fields:

```text
environment
action
authorizationIdSha256
authorizationSubjectSha256
authorizationSignatureEnvelopeSha256
actionSubjectSha256
actionDigestSha256
registrationRequestSha256
adminAuditDigestSha256
changeTicketSha256
rootAdminId
rootSessionEpoch
rootSessionBindingSha256
passkeyCredentialRowId
passkeyCredentialIdSha256
passkeyAssertionSubjectSha256
passkeyAssertionSignatureSha256
secureVerificationChallengeSha256
passkeyPreviousSignCount
passkeySignCount
passkeyUserPresent
passkeyUserVerified
passkeyBackupEligible
passkeyBackupState
registeredByServiceName
registeredByVersionId
registrationExecutionIdSha256
registrationCredentialIdSha256
authorityLedgerIdentitySha256
receiptSequence
ledgerHeadBeforeSha256
verificationExpiresAt
verifiedAt
```

This body is a projection of typed server-side state. It is never accepted as
proof merely because it parses. In Rust, both the verified WebAuthn proof and
the binding projection have private fields and constructors. The only
issuer-wire representation is the opaque
`DrainSourceRegistrationPermitIssueRequestV1` returned by the binding
projection's canonical encoder. It injects the fixed action and emits the
sorted 33-field JSON bytes that the HMAC signs; generic `serde_json`
serialization of a route DTO is forbidden.

The shared request canary is exactly 2,120 bytes with SHA-256:

```text
0af33ec080e15ee14f24877d805deed7fcf27fd5ebd8cda1a48313c0ba8416e1
```

### 4.2 HMAC request attestation

Service Binding is transport isolation, not semantic proof. The issuer MUST
accept a request only when both conditions hold:

1. the fetch arrived through the private staging Service Binding; and
2. `x-cinatoken-drain-source-registration-issuer` contains a valid HMAC
   attestation over the exact request body and request target.

The header is a compact three-part value:

```text
base64url(canonical_header_json)
.
base64url(canonical_claims_json)
.
base64url(HMAC-SHA256(signing_input))
```

No part permits base64url padding. The header object has exactly:

```json
{"alg":"HS256","kid":"<key-id>","typ":"CINATOKEN-DRAIN-SOURCE-REGISTRATION-PERMIT-ISSUER"}
```

The claims object has exactly:

```text
issuer
audience
credential_id_sha256
request_id
method
path_and_query
body_sha256
issued_at
expires_at
```

The signing input is:

```text
ASCII("cinatoken-drain-source-registration-permit-issuer-authority-v1\n")
|| header_part
|| ASCII(".")
|| claims_part
```

The claims MUST bind:

- the dedicated staging Application authority issuer;
- the dedicated staging issuer authority audience;
- the configured HMAC credential-ID SHA-256;
- one Application-generated request ID;
- exact method `POST`;
- exact path
  `/internal/v1/drain-source-registration/permits` with no query;
- lowercase SHA-256 of the exact body bytes;
- an issue time no more than 5 seconds in the future and no more than 60
  seconds in the past; and
- an expiry strictly after issue time and current time, with a maximum
  60-second HMAC lifetime.

The issuer MAY accept one current and one previous HMAC key during a bounded
rotation. Their key IDs and credential digests MUST be distinct. Unknown key,
bad signature, malformed token, wrong credential, body drift, target drift,
and time drift MUST share a coarse authorization failure and MUST NOT reveal
which check failed.

The HMAC credential identifies the Application-to-issuer attestation channel.
`registrationCredentialIdSha256` identifies the registration execution
credential committed by the typed action. V1 requires these two digests to be
equal, and the issuer compares them explicitly before signing. Name
similarity is not proof.

HMAC authentication does not prove that `passkeyUserVerified=true`, that a
counter transition is sound, or that D1 state is current. It proves only that
the holder of the configured Application HMAC secret attested to these exact
body bytes. The typed Application checks and final D1 checks remain mandatory.

## 5. Canonical Permit Subject

### 5.1 Exact 43-field order

The signed subject contains these fields in this exact order. JSON member
ordering is not the signature representation; this list is the canonical
signature order.

| No. | Field | Authoritative source or invariant |
|---:|---|---|
| 1 | `schemaVersion` | Issuer constant `1` |
| 2 | `contract` | Issuer constant `relay-container-drain-source-registration-permit-v1` |
| 3 | `issuer` | Dedicated permit-signer identity |
| 4 | `audience` | Exact local or staging Application audience |
| 5 | `keyId` | Deployment-pinned Ed25519 key ID |
| 6 | `signerIdentitySha256` | Deployment-pinned signer identity digest |
| 7 | `signerSpkiSha256` | SHA-256 of exact Ed25519 SPKI DER |
| 8 | `environment` | Typed action; staging verifier accepts only `staging` |
| 9 | `action` | Fixed registration action |
| 10 | `authorizationIdSha256` | Verified upstream authorization |
| 11 | `authorizationSubjectSha256` | Verified upstream authorization |
| 12 | `authorizationSignatureEnvelopeSha256` | Verified upstream authorization |
| 13 | `actionSubjectSha256` | Server-derived typed-action canonical digest |
| 14 | `actionDigestSha256` | Server-derived external action digest |
| 15 | `registrationRequestSha256` | Server-derived canonical request digest |
| 16 | `adminAuditDigestSha256` | Server-derived protected-audit projection digest |
| 17 | `changeTicketSha256` | Server-derived reviewed ticket digest |
| 18 | `rootAdminId` | Fresh D1 Root identity |
| 19 | `rootSessionEpoch` | Fresh D1 session epoch |
| 20 | `rootSessionBindingSha256` | Server-derived live session binding |
| 21 | `passkeyCredentialRowId` | Fresh D1 credential-row identity |
| 22 | `passkeyCredentialIdSha256` | Digest of verified credential ID |
| 23 | `passkeyAssertionSubjectSha256` | WebAuthn verifier output |
| 24 | `passkeyAssertionSignatureSha256` | WebAuthn verifier output |
| 25 | `secureVerificationChallengeSha256` | Digest of exact action-bound challenge |
| 26 | `passkeyPreviousSignCount` | Fresh D1 credential count used by 0074 CAS |
| 27 | `passkeySignCount` | New count from verified authenticator data |
| 28 | `passkeyUserPresent` | Must be `true` |
| 29 | `passkeyUserVerified` | Must be `true` |
| 30 | `passkeyBackupEligible` | Verified authenticator flag |
| 31 | `passkeyBackupState` | Verified flag; cannot be true when eligibility is false |
| 32 | `registeredByServiceName` | Fixed reviewed Application service |
| 33 | `registeredByVersionId` | Exact Application deployment version |
| 34 | `registrationExecutionIdSha256` | One execution identity digest |
| 35 | `registrationCredentialIdSha256` | Registration execution credential digest |
| 36 | `authorityLedgerIdentitySha256` | Fresh authority-ledger identity |
| 37 | `receiptSequence` | Fresh expected next receipt sequence |
| 38 | `ledgerHeadBeforeSha256` | Fresh ledger head before registration |
| 39 | `verificationExpiresAt` | Action/WebAuthn verification deadline |
| 40 | `permitIdSha256` | Issuer-derived request-bound replay identity |
| 41 | `verifiedAt` | Application-assigned proof verification time |
| 42 | `issuedAt` | Issuer-assigned issue time |
| 43 | `expiresAt` | Issuer-assigned bounded expiry |

The issuer and verifier MUST enforce the signature-count rule:

```text
(passkeyPreviousSignCount == 0 && passkeySignCount == 0)
||
(passkeySignCount > passkeyPreviousSignCount)
```

Both values are unsigned 32-bit integers. A previous nonzero count followed by
zero, an equal nonzero count, or any decrease is clone/counter evidence and
MUST fail closed. The `0/0` case supports authenticators without a usable
counter; replay protection then depends on the one-shot challenge, permit
identities, assertion digest, request ID, and atomic 0074 uniqueness checks.

### 5.2 Length-prefixed canonical form

The subject domain is the ASCII byte string:

```text
cinatoken-relay-container-drain-source-registration-permit-v1
```

It has no length prefix, NUL terminator, or trailing newline. For each field in
the fixed order above:

```text
LP(value) = u32_be(byte_length(UTF8(canonical_text(value))))
            || UTF8(canonical_text(value))
```

The signed message is:

```text
subject_message = ASCII(subject_domain)
                  || LP(field_1)
                  || ...
                  || LP(field_43)
```

Canonical text rules:

- integers are unsigned base-10 ASCII without signs or leading zeroes, except
  the value zero is `"0"`;
- booleans are exactly `"true"` or `"false"`;
- SHA-256 values are exactly 64 lowercase hexadecimal characters;
- identifiers are bounded ASCII and match their contract-specific grammar;
- service and version identities are non-empty and bounded;
- all timestamps are positive safe integers measured in Unix seconds; and
- no Unicode normalization, JSON serialization, locale, platform newline, or
  floating-point conversion participates in the signed bytes.

The implementation MUST sign `subject_message`, not the raw JSON response.
Rust and TypeScript MUST share a frozen byte-for-byte test vector.

### 5.3 Permit ID

`permitIdSha256` is derived by the issuer, not copied from the request. Its
domain is:

```text
cinatoken-relay-container-drain-source-registration-permit-id-v1
```

Its canonical values, in order, are:

```text
authenticated HMAC request_id
actionSubjectSha256
passkeyAssertionSignatureSha256
secureVerificationChallengeSha256
issuedAt
expiresAt
```

The permit ID is SHA-256 of the domain plus the same LP encoding. The
Application verifier MUST recompute it using the request ID it retained when
creating the HMAC attestation. A request ID returned by the issuer or supplied
inside an untrusted response cannot replace that retained value.

## 6. Ed25519 Envelope And Digest

The JSON envelope has exactly:

```json
{
  "schemaVersion": 1,
  "contract": "relay-container-drain-source-registration-permit-envelope-v1",
  "algorithm": "Ed25519",
  "subject": {},
  "subjectSha256": "<lowercase-hex>",
  "signatureBase64url": "<unpadded-base64url>"
}
```

The envelope parser MUST reject missing, duplicate, or unknown members. The
signature MUST decode canonically to exactly 64 bytes.

The trusted public key is a canonical unpadded base64url Ed25519
SubjectPublicKeyInfo value. Its decoded DER is exactly 44 bytes:

```text
302a300506032b6570032100 || 32-byte Ed25519 public key
```

The verifier MUST:

1. decode the SPKI canonically;
2. require the exact DER prefix and length;
3. hash the exact DER and compare it with the pinned SPKI SHA-256;
4. reconstruct the canonical 43-field subject message;
5. compare `subjectSha256` with SHA-256 of that message; and
6. verify the Ed25519 signature over that message.

After signature verification, the Application derives
`permitSignatureEnvelopeSha256`. Its domain is:

```text
cinatoken-relay-container-drain-source-registration-permit-envelope-v1
```

The digest input is the domain followed by LP encoding of:

```text
Ed25519
issuer
audience
keyId
signerIdentitySha256
signerSpkiSha256
subjectSha256
canonical signatureBase64url
```

This server-derived digest is the future 0074 permit receipt and replay key.
It MUST NOT be accepted from the issuance request, permit JSON metadata, or
browser. The issuer MAY return it for cross-checking, but the Rust verifier
MUST recompute it and the writer MUST consume only the verifier result.

## 7. Time Semantics

All times use Unix seconds and must fit the JavaScript safe-integer range.

HMAC attestation:

- maximum lifetime: 60 seconds;
- maximum future clock skew: 5 seconds;
- `expires_at > issued_at`;
- `issued_at <= now + 5`;
- `now - issued_at <= 60`; and
- `now < expires_at`.

Permit:

- `verifiedAt <= issuedAt`;
- `issuedAt - verifiedAt <= 5`;
- `issuedAt <= now + 5`;
- `verifiedAt <= now + 5`;
- `5 <= expiresAt - issuedAt <= 30`;
- `now < expiresAt`; and
- `expiresAt <= verificationExpiresAt`.

The issuer computes:

```text
issuedAt = authenticated_hmac_issued_at
expiresAt = min(
  authenticated_hmac_issued_at + 30,
  authenticated_hmac_expires_at,
  verificationExpiresAt
)
```

The server clock must still fall inside the authenticated HMAC window and
before the derived permit expiry. If the original permit lifetime is shorter
than 5 seconds or the derived permit is already expired, issuance fails. The
issuer MUST NOT extend either authenticated window. Replaying the exact HMAC
token and exact body while valid therefore returns the same permit ID,
subject, Ed25519 signature, and envelope bytes without introducing storage.
The verifier rechecks the entire window, and 0074 MUST check expiry again
using D1 `unixepoch()` inside the atomic statement.

No browser-supplied timestamp can authorize acceptance. Clock uncertainty
outside the bounded skew fails closed.

## 8. Live State And Sign-Count CAS

The Application must perform fresh first-primary D1 checks at each
irreversible boundary. Cached auth, KV, process memory, a session cookie, the
begin snapshot, and the issuer's signature are not current-state evidence.

### 8.1 Before challenge creation

The Application MUST verify:

- the actor is the same enabled Root administrator;
- the session is active, not revoked or expired, and has the expected epoch;
- the passkey credential row belongs to the Root, is enabled, and has no
  sticky clone warning;
- the upstream authorization is current and unused;
- the fence, generation, source scope, ledger identity, receipt sequence, and
  head match the typed action; and
- the registration request, audit projection, ticket, service version, and
  execution identities are canonical and reviewed.

The one-shot ceremony state then captures these bindings and the previous
credential count.

### 8.2 Before issuance request

After consuming the one-shot challenge and cryptographically verifying the
assertion, the Application MUST reread Root, session, credential,
authorization, fence, ledger identity, receipt sequence, and head. It MUST
confirm that the credential row still contains
`passkeyPreviousSignCount`, then enforce the count rule against the verified
`passkeySignCount`.

This step does not advance the count. It proves that the Application is about
to attest to a request built from a current pre-CAS snapshot. The HMAC is then
computed over the exact canonical request bytes.

### 8.3 Before 0074

After the Rust verifier accepts the permit, the Application MUST perform
another first-primary reread. It MUST prove:

- Root, session, role, epoch, and session binding are unchanged and active;
- the credential row is unchanged, enabled, belongs to the same Root, has no
  clone warning, and still has `passkeyPreviousSignCount`;
- the authorization remains current and unconsumed;
- fence/generation and authority ledger identity/sequence/head still match;
- action/request/audit/ticket and deployment identities still match; and
- both action verification and permit remain unexpired.

Any drift discards the permit and produces no registration.

### 8.4 Atomic CAS in 0074

The single 0074 top-level statement MUST update the credential using the old
count as its compare-and-swap predicate:

```text
WHERE credential_row_id = :passkeyCredentialRowId
  AND sign_count = :passkeyPreviousSignCount
  AND credential_id_sha256 = :passkeyCredentialIdSha256
  AND user_id = :rootAdminId
  AND enabled = 1
  AND clone_warning = 0
```

The same statement sets the stored count to `passkeySignCount`, records the
D1-derived use/update time tied to `verifiedAt`, and projects the command,
protected audit, registration, and ledger rows. For a `0/0` authenticator, the
row update still performs the exact predicate and updates the protected usage
metadata; uniqueness and one-shot identities provide replay protection.

If the CAS affects anything other than exactly one credential row, the entire
statement MUST fail. No count update may commit without the command, audit,
registration, and ledger, and no registration may commit without the count
update.

## 9. Isolated Issuer Behavior

The issuer request path MUST execute in this order:

1. reject disabled configuration before reading secrets;
2. require exact method, path, empty query, content type, and bounded body;
3. authenticate the HMAC over the exact body bytes;
4. parse canonical JSON and require the exact 33 request fields;
5. validate all shapes, fixed values, digest relationships, count transition,
   backup flags, and time bounds;
6. derive issuer-controlled fields and `permitIdSha256`;
7. sign the canonical 43-field subject;
8. verify the signature with the configured public key;
9. derive the subject and signature-envelope digests; and
10. return a bounded `Cache-Control: no-store` response.

The issuer MUST reject configuration unless:

- environment is exactly `local` or `staging`;
- the enable gate is exactly `true` at runtime;
- HMAC authority issuer/audience and permit issuer/audience are all present
  and intentionally distinct by role;
- current HMAC key ID, credential digest, and secret are complete;
- any previous HMAC slot is either wholly absent or wholly valid;
- Ed25519 key ID, signer identity digest, SPKI digest, PKCS8, and SPKI are
  complete;
- PKCS8 is the exact Ed25519 48-byte DER form;
- SPKI is the exact 44-byte Ed25519 DER form;
- private and public keys form one pair; and
- signer identity and SPKI digests are not accidentally reused as unrelated
  authority identities.

The issuer MUST fail with `503` when signing or self-verification is uncertain.
It MUST never return an unsigned permit, a partially verified envelope, raw
key material, HMAC claims, or secret diagnostics.

The response contains exactly the signed envelope, subject digest,
signature-envelope digest, authenticated request-ID echo, and bounded issuer
Worker version ID. Worker version and request correlation are non-authorizing
metadata. The response MUST not be cached.

## 10. Application Rust Verifier

The verifier trust tuple is all-or-nothing:

```text
DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER
DRAIN_SOURCE_REGISTRATION_PERMIT_AUDIENCE
DRAIN_SOURCE_REGISTRATION_PERMIT_KEY_ID
DRAIN_SOURCE_REGISTRATION_PERMIT_ISSUER_IDENTITY_SHA256
DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL
DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_SHA256
```

The verifier MUST fail closed if any member is missing, empty, malformed, or
inconsistent. It MUST compare all six values exactly with the signed subject
and decoded SPKI.

The verifier consumes the exact complete issuer response bytes in one
`deny_unknown_fields` parse. It does not ask route code to extract and
reserialize the nested envelope. The verifier MUST then:

1. enforce a bounded response size and strict response/envelope JSON schemas;
2. enforce schema, contract, algorithm, environment, and action;
3. enforce all identifier, digest, integer, boolean, and relationship rules;
4. enforce the previous/new sign-count rule;
5. byte-compare the subject's canonical 33-field request projection with the
   opaque Application-derived issue request;
6. compare the response request ID with the retained HMAC request ID;
7. recompute the request-bound permit ID using that retained request ID;
8. enforce all causal time rules;
9. reconstruct and hash the canonical 43-field subject;
10. verify the pinned SPKI and Ed25519 signature;
11. derive the signature-envelope digest; and
12. compare both top-level digest echoes with the locally derived values.

Validation order MUST not create an oracle that exposes key or secret details.
The external response uses coarse codes; detailed internal reason data is
limited to non-secret structured metrics.

`VerifiedDrainSourceRegistrationPermit` MUST:

- have private fields and private constructors;
- not implement request deserialization;
- carry the exact verified subject privately;
- expose only reviewed read-only accessors needed by 0074;
- expose server-derived permit ID, subject digest, and signature-envelope
  digest; and
- be the only permit type accepted by the future writer.

Application production builds and configuration MUST contain no signer,
PKCS8, HMAC secret, issuance client, or code path that can mint this type.

## 11. Configuration Isolation

### 11.1 Issuer local and isolated staging only

Only these issuer configurations may exist:

```text
services/drain-source-registration-permit-issuer/wrangler.jsonc
services/drain-source-registration-permit-issuer/wrangler.staging.jsonc
```

Both MUST have:

- `workers_dev=false`;
- `preview_urls=false`;
- no `routes` or public/custom domain;
- no D1, KV, R2, Queue, Durable Object, Container, asset, browser, AI,
  analytics, dispatch, tail-consumer, mTLS, Hyperdrive, Vectorize, service, or
  rate-limit binding;
- only Worker version metadata as a non-authority platform binding;
- distinct local/staging names and identities;
- the issuance gate checked in as `false`; and
- no checked-in secret or non-empty key material.

Staging ingress is provided only by an Application Service Binding configured
on the staging Application side. The issuer itself does not need or receive an
outbound service binding.

Secrets are provisioned out of band:

```text
DRAIN_SOURCE_REGISTRATION_HMAC_CURRENT_SECRET
DRAIN_SOURCE_REGISTRATION_HMAC_PREVIOUS_SECRET
DRAIN_SOURCE_REGISTRATION_PERMIT_PKCS8_BASE64URL
DRAIN_SOURCE_REGISTRATION_PERMIT_SPKI_BASE64URL
```

Secret values MUST never appear in tracked files, shell history, CLI
arguments, CI logs, build artifacts, D1, R2, telemetry, or support output.

There MUST be no:

```text
wrangler.production.jsonc
wrangler.prod.jsonc
[env.production]
production issuer deploy target
production issuer secret set
production issuer route
```

CI configuration audits MUST fail if any production issuer configuration,
public ingress, forbidden binding, enabled tracked gate, or secret literal is
introduced. The audit MUST inventory Git tracked plus non-ignored candidate
files across the entire issuer service, reject `.dev.vars*`, `.env*`, private
key/credential filenames, and common credential literals. Local `.dev.vars*`
and `.env*` patterns stay ignored so an ordinary add cannot stage them; any
force-tracked secret filename still fails the candidate inventory.

### 11.2 Production Application must prove absence

Production Application configuration MUST completely omit, rather than set to
false or empty:

- every drain-source registration issuance gate;
- every issuer Service Binding;
- every issuance-specific rate limiter;
- every HMAC authority identity, key ID, credential digest, and secret;
- all six permit-verifier trust variables;
- every local/staging issuer audience or identity; and
- any registration coordinator route or writer gate.

False placeholders are not acceptable because their presence increases the
production capability surface and can be enabled by a later variable-only
change. Static config audits MUST prove absence in every production
environment, generated Wrangler config, CI deploy manifest, and secret-name
inventory.

This v1 issuer is not promoted to production. Any future production design
requires a separate reviewed contract, explicit authority decision, threat
model, migration, evidence packet, and approval. Copying the staging config is
forbidden.

## 12. End-To-End Flow

The intended future flow is:

1. **Begin live checks:** authenticate Root and reread Root, session,
   credential, authorization, fence, and ledger state from first-primary D1.
2. **Build typed action:** recompute canonical request/audit/ticket digests,
   bind deployment and execution identities, and create the exact action.
3. **Create ceremony once:** derive the action-bound challenge and store it
   with Durable Object put-once semantics.
4. **Finish consume once:** take the ceremony exactly once before verifying
   the assertion; a retry uses a new ceremony.
5. **Verify WebAuthn:** require exact challenge/origin/RP ID, UP and UV, valid
   signature, credential ownership, backup consistency, and count transition.
6. **Pre-issuance reread:** confirm Root/session/credential/fence/head remain
   current and the credential still has `passkeyPreviousSignCount`.
7. **Attest exact request:** serialize the 33-field canonical body, compute
   its SHA-256, and HMAC-bind issuer, audience, credential, request ID, method,
   path, body, and time.
8. **Issue narrow permit:** the isolated issuer authenticates the exact body,
   validates it, signs the 43-field subject, self-verifies, and returns a
   no-store envelope.
9. **Verify locally:** the Rust verifier compares all typed bindings, request
   ID, trust pins, count rule, canonical bytes, time, and signature.
10. **Pre-writer reread:** first-primary D1 proves Root/session/credential/
    authorization/fence/head are still exact and unexpired.
11. **Atomic 0074 command:** one top-level statement performs the credential
    CAS and projects command, protected audit, registration, and ledger.
12. **Same-Session readback:** exact readback classifies success, exact replay,
    conflict, or unknown outcome before any capability is returned.

The issuer response grants no collection authority. A successful 0074
registration still does not authorize a collector, claim worker, terminal
worker, source close, traffic change, or migration promotion.

## 13. Replay, Atomicity, And Outcome Classification

### 13.1 Replay identities

Migration 0074 MUST enforce uniqueness for at least:

- `permitIdSha256`;
- permit subject SHA-256;
- permit signature-envelope SHA-256;
- HMAC request ID within the registration command scope;
- action subject SHA-256;
- secure-verification challenge SHA-256;
- passkey assertion-signature SHA-256;
- registration execution identity;
- the protected audit request ID; and
- the 0073 registration and ledger identities.

Raw HMAC tokens, signatures, challenge bytes, and assertion bytes MUST not be
stored.

### 13.2 One atomic statement

The single top-level insert MUST atomically produce:

1. one append-preserved registration command;
2. one protected canonical `logs` row with
   `auth_method=passkey`;
3. one exact credential-row CAS update;
4. one 0073 drain-source registration; and
5. one corresponding ledger append.

The command must validate the complete permit, typed action, live Root,
session, credential, authorization, fence, ledger, expiry, and audit
projection. A trigger or subquery failure rolls back every effect.

Because the credential CAS adds a protected row update, the previous planned
fresh `meta.changes=4` value is superseded. The candidate expected value is
`meta.changes=5`, with exact replay `meta.changes=0`, but neither number is
accepted as evidence until a real Workerd test proves trigger accounting and
exact same-Session readback. Any other value, malformed metadata, batch error,
readback drift, or lost response without exact readback is `OutcomeUnknown`.

### 13.3 Retry semantics

An exact retry may return the original result only when:

- D1 reports no new changes;
- the same Session reads the exact command, audit, credential post-CAS,
  registration, and ledger projections;
- all immutable permit, action, proof, request, actor, and receipt digests
  match; and
- no conflicting row or later state is mistaken for the original result.

Reusing one permit for a different request, actor, credential, action, audit,
fence, head, or registration is a conflict. Reusing one proof under a
different permit is a conflict. A second successful mutation is forbidden.

The permit MUST NOT be consumed in a Durable Object before D1. Doing so would
burn the capability when D1 fails or a response is lost. The Durable Object
owns only one-shot ceremony state; D1 owns final permit consumption.

## 14. Failure And Response Principles

Every response from the issuer and future coordinator MUST include
`Cache-Control: no-store`. Error bodies are bounded, stable, and contain only
a coarse machine code. A bounded non-secret correlation ID MAY be added only
when one is available without echoing unauthenticated input. Error bodies MUST
NOT contain secrets, tokens, signatures, key IDs not already public, SPKI
bytes, raw request bodies, assertion material, SQL, stack traces, or D1 row
content.

Recommended categories:

| HTTP | Category | Examples |
|---:|---|---|
| 400 | malformed request | invalid UTF-8/JSON, non-canonical body, unknown/missing field |
| 403 | authorization rejected | HMAC invalid, binding mismatch, UV/count/trust/policy drift |
| 405 | method rejected | method other than exact `POST` |
| 409 | conflict | ceremony/permit/request replay with different immutable bindings |
| 410 | expired or consumed proof | consumed ceremony or expired verification capability |
| 413 | request too large | declared or streamed body exceeds limit |
| 415 | media type rejected | content type is not JSON |
| 429 | abuse control | Application-side issuance rate limit exceeded |
| 503 | unavailable or uncertain | signing failure, D1 unknown outcome, required dependency unavailable |

Authentication failures SHOULD collapse to one `403` issuer code. Permit
verification failures SHOULD collapse into stable envelope, trust, binding,
validity, or signature families without revealing the failed secret/key
selection. No failure before 0074 mutates registration state. An uncertain
0074 result is never reported as success without exact readback.

Logs and metrics use an allowlist such as service, version, coarse code,
latency bucket, and correlation digest. Full permit bodies, request IDs,
credential IDs, actor IDs, and security digests are not emitted unless a
separately reviewed redacted metric explicitly requires them.

## 15. Required Test Matrix

### 15.1 Cross-language canonical vectors

- one frozen TypeScript-to-Rust Ed25519 vector covering all 43 fields;
- fixed canonical message length, subject SHA-256, permit ID, signature,
  SPKI SHA-256, and signature-envelope SHA-256;
- one-field drift tests for every field, including
  `passkeyPreviousSignCount`;
- field-order, domain, LP length, UTF-8, integer, boolean, and lowercase-digest
  drift;
- unknown, missing, duplicate, and differently cased JSON members; and
- padded/non-canonical base64url, malformed DER, wrong SPKI prefix, and wrong
  signature length.

### 15.2 HMAC request attestation

- current and previous key success with distinct identities;
- unknown key, bad signature, wrong secret, partial rotation slot;
- issuer, audience, credential, request ID, method, path, query, or exact-body
  drift;
- canonical body versus semantically equal but byte-different JSON;
- body truncation, declared/streamed oversize, invalid UTF-8, and wrong media
  type;
- issue/expiry/skew boundaries and replay outside the window; and
- proof that Service Binding access without HMAC is rejected.

### 15.3 Action and WebAuthn

- exact challenge, origin, RP ID, credential, user handle, UP, and UV;
- UV downgrade, UP false, invalid signature, challenge reuse, and ceremony
  replacement;
- sticky clone warning and newly detected counter rollback;
- valid `0/0`, valid `0/N`, and valid increasing nonzero count;
- invalid nonzero-to-zero, equal nonzero, and decreasing count;
- invalid backup-state/eligibility combination;
- 32 concurrent put-once/take attempts with one winner; and
- proof-derived digests cannot be supplied directly by request JSON.

### 15.4 Issuer and verifier

- local/staging audience, environment, issuer, key, identity, and SPKI
  isolation;
- cross-audience, cross-environment, cross-action, cross-key, and
  cross-service replay rejection;
- request-ID-bound permit ID drift;
- minimum/maximum lifetime, verification expiry, future skew, and expiry at
  the exact second;
- count-rule enforcement independently in issuer and Rust verifier;
- signer self-verification failure and unavailable WebCrypto;
- envelope size/shape and all typed-binding drift; and
- the verified result cannot be deserialized or constructed by route code.

### 15.5 Live D1 and 0074

- Root disabled/demoted, session revoked/expired/epoch changed;
- credential disabled/reassigned/replaced, clone warning, credential-ID drift,
  and previous-count drift;
- two concurrent 0074 writers using the same previous count, with one winner;
- `0/0` replay and concurrency protected by permit/proof/request uniqueness;
- authorization consumed/expired, fence/generation drift, receipt-sequence
  drift, and ledger-head drift;
- action/request/audit/ticket/service/version/execution drift;
- exact fresh projection, exact replay, conflicting replay, response loss,
  malformed metadata, and same-Session readback failure;
- rollback of command, audit, credential CAS, registration, and ledger when
  any projection fails;
- append-preservation and update/delete guards for command/protected audit/
  registration/ledger; and
- real Workerd proof of the final `meta.changes` accounting rather than a
  SQLite-only assumption.

### 15.6 Configuration and deployment

- config-schema validation for local and staging;
- static rejection of public routes, `workers.dev`, preview URLs, and every
  forbidden binding family;
- no issuer production config or production deploy target;
- production Application absence of issuance gate, Service Binding, rate
  limiter, HMAC material, and verifier trust tuple;
- tracked gates remain false and tracked key/credential fields remain empty;
- local and staging use the same reviewed compatibility date, regenerate their
  Wrangler types on every date or binding change, and exercise the actual
  staging config under Workerd;
- `nodejs_compat` remains intentionally absent because this isolated service
  imports no Node modules and uses only Workers/Web Platform APIs;
- secret scanner proves no private key or HMAC value in repository/artifacts;
- issuer/collector/claim/close/reopen/deployment identity reuse rejection;
- generated Worker types match reviewed config; and
- isolated-staging N/N-1 key rotation, disable-first rollback, and no-store
  behavior.

## 16. Deployment Gates And NO-GO Conditions

### 16.1 Local checkpoint

Local code and tests may establish protocol compatibility only. Local success
is not remote Cloudflare evidence and cannot enable registration.

At this checkpoint:

- the action-bound registration contract, one-shot ceremony foundation, and
  typed WebAuthn proof foundation are present locally and remain private,
  route-free, and writer-free;
- the permit-binding projection now carries the previous and new passkey
  counts;
- the storage-free issuer and Rust verifier implement the 43-field contract,
  exact HMAC-window replay, audience/SPKI pins, and the same deterministic
  TypeScript/Rust Ed25519 vector;
- generated types, dry-run build, exact configuration allowlist, production
  omission audit, service tests, and real-Workerd replay tests are local
  evidence only;
- no private coordinator route is connected;
- migration 0074 and its writer do not exist;
- no isolated-staging deployment or remote readback is claimed; and
- no production configuration, deployment, credential, route, gate, trust, or
  authority change is claimed.

### 16.2 Isolated-staging entry gate

Isolated staging remains **NO-GO** until all of the following are true:

- issuer service entrypoint, protocol, tests, generated types, and static
  configuration audit pass;
- Rust verifier and cross-language vectors pass for the 43-field contract;
- Application pre-issuance and pre-writer live rereads are implemented;
- issuer is reachable only by the staging Service Binding plus exact-body
  HMAC;
- all staging keys, identities, audiences, and credential digests are distinct
  and reviewed;
- gates are enabled only through an explicit bounded staging change;
- no forbidden binding or public ingress exists;
- 0074 migration, atomic writer, count CAS, protected audit, uniqueness, fault
  tests, and same-Session readback pass;
- response-loss and concurrent replay campaigns produce no second
  registration; and
- disable-first rollback is rehearsed without deleting evidence.

### 16.3 Production gate

Production remains **NO-GO** if any of these conditions exists:

- any production issuer config, secret, Service Binding, trust tuple, issuance
  gate, rate limiter, or route exists;
- the v1 local/staging issuer can be selected by production configuration;
- Root/session/credential/fence/head checks use cache or stale snapshots;
- sign-count previous/new values are missing or 0074 does not CAS on the
  previous value;
- audit, credential CAS, registration, and ledger can commit separately;
- permit consumption occurs outside the atomic D1 command;
- exact replay or response loss cannot be classified by same-Session
  readback;
- a permit can authorize collection or another control-plane action;
- remote evidence, key custody, separation of duties, incident response,
  rollback, and independent approvals are incomplete; or
- Go/VPS retirement, traffic transfer, close, reopen, billing, or settlement
  is inferred from M1 registration evidence.

Passing isolated staging does not remove these production conditions. This
document authorizes no production deployment.

## 17. Completion Evidence

An implementation claim for this specification must identify:

- the exact commit and clean tracked diff;
- issuer and verifier source/config files;
- the frozen cross-language vector and all 43-field drift tests;
- HMAC exact-body and Service Binding isolation tests;
- Rust unit, wasm check, TypeScript check, config audit, and Workerd results;
- migration 0074 schema/PRAGMA fingerprints and atomicity tests;
- the exact observed fresh/replay `meta.changes` values;
- isolated-staging deployment/version IDs and secret-free config inventory;
- remote ingress-negative evidence and production-absence audit;
- replay, response-loss, CAS-race, and rollback evidence; and
- independent security and operations approval.

Until that evidence exists, the correct statement is that the M1 protocol is
specified and partially implemented locally, while registration,
isolated-staging activation, production migration, and Go/VPS retirement
remain **NO-GO**.
