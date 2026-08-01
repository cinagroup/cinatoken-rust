# Drain-Source Registration Application Begin Assembly

Date: 2026-08-01

Status: implemented as a route-free, default-off staging candidate. No browser
route calls it, local and staging configuration are intentionally incomplete,
and production has no capability. This document is an implementation contract,
not remote deployment or cutover evidence.

## Purpose

This layer connects five previously separate trust boundaries without moving
authority out of D1 or the coordinator Durable Object:

1. the existing Rust session codec and live-user recheck;
2. a redacted Root-session anchor;
3. one exact first-primary D1 registration snapshot;
4. typed action, begin-intent, WebAuthn, and phase-proof construction; and
5. the retained Application checkpoint and private coordinator client.

It follows the cinaVibeSDK design distinction used by this migration: a named,
durable per-entity authority owns lifecycle state before an ephemeral execution
boundary is crossed. Here the Application ceremony and coordinator Durable
Object are durable authorities; later 0074 execution and container work are
downstream effects. This path does not copy public preview, dynamic code, or
fail-open behavior from cinaVibeSDK.

## Source Boundaries

- `container_drain_source_registration_application_session.rs` derives the
  redacted Root-session anchor.
- `container_drain_source_registration_application_begin.rs` performs exact
  snapshot-to-`Prepared` assembly.
- `container_drain_source_registration_coordinator.rs` validates the snapshot
  and derives semantic authority.
- `container_drain_source_registration_application_orchestrator.rs` signs the
  phase proof and provides persist-before-dispatch/reconciliation.
- `container_drain_source_registration_application_ceremony.rs` owns the
  create-only/CAS Application checkpoint.
- `d1_repositories.rs` owns the one-statement first-primary snapshot.

All modules are private to the Application Worker. None owns a route.

## Required Ordering

```text
verified Cookie through SessionCodec
  -> live D1 user role/status/session_epoch recheck
  -> digest-only Root session anchor
  -> synchronous begin/signer/client/config preflight
  -> exact first-primary D1 snapshot
  -> typed begin intent at snapshot.database_now
  -> semantic authority validation
  -> exact action and mandatory-UV challenge
  -> before-challenge phase proof sign + immediate verify
  -> deterministic coordinator BeginRequestV1
  -> Application Prepared checkpoint
  -> create-only checkpoint persistence
  -> private coordinator Service Binding dispatch
  -> generation-one Application CAS
  -> browser challenge may eventually be returned
```

The current implementation begins at the live-refreshed `SessionClaims`
boundary. A future request adapter must call `require_root_auth`; passing
unparsed Cookie bytes into the assembly layer is forbidden.

## Redacted Root Session

`VerifiedApplicationRootSessionV1::from_live_root_claims` requires:

- positive JavaScript-safe Root user ID;
- exact Root role and enabled status;
- nonnegative JavaScript-safe `session_epoch`;
- positive `iat`, with `iat < exp`; and
- canonical base64url `sid` decoding to exactly 32 bytes.

It ignores mutable username/group presentation fields. It derives two distinct
SHA-256 values with independent domains and u32 big-endian length framing:

- `cinatoken-drain-source-registration-root-session-id-v1` commits the decoded
  32-byte `sid`;
- `cinatoken-drain-source-registration-root-session-binding-v1` commits Root
  ID, role, status, epoch, issue/expiry time, and the decoded `sid`.

The resulting object retains only typed Root/session fields and digests. It has
no `Debug` implementation and stores no Cookie, username, group, or raw `sid`.
An independent Bun/Node SHA-256 implementation produced the fixed vectors used
by the Rust test.

This adapter is not a replacement for signature verification. The caller must
first use the existing session codec and live D1 recheck. The later exact
registration snapshot independently compares Root role/status/deletion and
`session_epoch`, closing the gap between session authentication and challenge
authority.

## Digest-Only Begin Draft

`DrainSourceRegistrationApplicationBeginDraftV1` accepts only bounded typed
metadata produced after request controls have succeeded:

- authorization and exact Passkey credential digests;
- operation, ceremony, request-intent, action, request, audit, change-ticket,
  execution, and ceremony-nonce digests;
- RP ID and Origin;
- a typed HMAC of the trusted client network identity;
- a bounded reason code and 30-300 second verification lifetime.

Every supplied SHA-256 value must be lowercase canonical hex and all draft
digest domains must be distinct. The draft has no serde decoder and no public
route can construct it today. The future request adapter must derive these
values from bounded canonical request bytes after Origin, CSRF, Root, audit,
rate-limit, and trusted-network checks; it must not accept client-provided
digests as authority.

Application deployment identity is not supplied by the draft:

- service name is fixed as `cinatoken-relay-application`;
- version comes from `CF_VERSION_METADATA`;
- credential identity comes from the non-secret
  `DRAIN_SOURCE_REGISTRATION_APPLICATION_CREDENTIAL_ID_SHA256` variable.

The credential variable is empty in tracked local/staging configuration, so
the candidate cannot execute accidentally. Production omits it completely.

## Exact Snapshot Assembly

`prepare_application_begin` performs a secret-bearing signer/client preflight
synchronously and drops that configuration before its first D1 await. It then:

1. derives the redacted Root-session anchor;
2. obtains `DB` and calls the exact snapshot with authorization digest, Root
   user ID, and exact Passkey credential digest;
3. creates the begin intent with the snapshot's `database_now`;
4. validates authorization, Root/session, Passkey, fence/head, zero
   consumption, ledger predecessor, bookmark, and time in one semantic
   authority step;
5. builds the action only from the validated authorization, Passkey, ledger,
   session anchor, deployment identity, and digest-only draft;
6. creates the mandatory-UV WebAuthn challenge and confirms that the begin
   intent exactly matches the action;
7. reloads the staging signer, signs, and immediately verifies the typed
   before-challenge phase proof; and
8. freezes one `Prepared` Application checkpoint.

No snapshot field is reread piecemeal. The D1 query is the only source of Root,
Passkey, fence/head, ledger, and consumption authority used by this assembly.

## Deterministic Coordinator Request

The coordinator begin request contains the prepared authority fingerprint,
begin-intent digest, ceremony ID, verified phase-proof digest, challenge
digest, generation zero, exact expiry, and canonical coordinator identity.

Its request ID is not caller supplied. It is derived with u32 length framing
under
`cinatoken-drain-source-registration-coordinator-begin-request-id-v1` from the
begin-intent digest. This makes initial dispatch and recovery share one stable
request identity without minting replacement entropy.

`prepare_and_dispatch_application_begin` hands the checkpoint to the existing
orchestrator. Within dispatch, create-only Application persistence remains the
first await and precedes the private Service Binding call. Reconciliation still
reads the deterministic Application object and exact-replays retained bytes.

## Failure Semantics

| Boundary | Failure | Result |
|---|---|---|
| live Root claims | malformed, non-Root, disabled, invalid epoch/time/sid | deterministic rejection before D1 |
| capability preflight | disabled gate, missing signer/client/binding | not dispatched; no D1 read |
| Application credential | missing or malformed digest | configuration rejection before D1 |
| D1 snapshot | transport/read uncertainty | indeterminate read; no downstream dispatch |
| D1 snapshot | authorization row absent | deterministic missing-authority result |
| semantic authority | Root/session/Passkey/fence/ledger/time drift | deterministic fail-closed rejection |
| phase proof | key rotation/config/sign/verify failure | no checkpoint or coordinator dispatch |
| checkpoint freeze | impossible action/intent/request relationship | protocol rejection |
| checkpoint persistence or coordinator | unknown outcome | existing deterministic readback/exact replay path |

Errors expose stable codes only. Underlying D1, secret, Cookie, and proof
material is not included in `Debug` or response-oriented diagnostics.

## Current Evidence

Current local evidence includes:

- 40 focused Worker registration tests;
- two independent SQLite snapshot tests;
- nine source/config tests with 310 assertions;
- coordinator service, Workerd, Wrangler dry-run, Rust, and wasm32 checks;
- the complete `bun run check` repository gate in 1041.9 seconds; and
- fixed vectors independently computed with Bun/Node for Root-session and
  coordinator request-ID domains.

This evidence proves pure assembly and existing storage/transport components.
It does not prove one live browser-to-coordinator call through this new
function because there is intentionally no route or named entrypoint.

## Remaining P0

Before isolated staging enablement:

1. add a bounded request adapter that calls `require_root_auth`, enforces exact
   Origin/RPID, CSRF, body bounds, trusted-network extraction, rate limits, and
   immutable audit/change-ticket inputs before creating any draft entropy;
2. derive every draft digest from canonical server-owned inputs and call
   `prepare_and_dispatch_application_begin`;
3. return the challenge only after coordinator and Application durable
   readback both prove `ChallengeIssued`;
4. implement finish claim before assertion parsing, mandatory-UV verification,
   fresh before-issuer/before-commit snapshots and proof chain, bounded permit
   issuance, immutable 0074 execution, and same-Session alias recovery;
5. add combined Workerd and remote staging fault/load evidence; and
6. retain observability, deletion/retention, rollback, and independent approval
   artifacts.

No remote Cloudflare command, resource, secret, migration, deployment, route,
traffic, DNS, D1 mutation, or Go/VPS change is authorized by this document.
Go/VPS remains authoritative and production remains **NO-GO**.
