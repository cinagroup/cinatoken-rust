# Relay Container Shard Placement Mutation Authorization

Date: 2026-07-28

Status: local implementation complete for staging-only permit verification,
atomic D1 consumption, and Controller pre-wake enforcement. No permit issuer,
deployment runner, remote schema, live permit, writer-enabled deployment, or
placement evidence is claimed. Production remains **NO-GO**.

## Purpose

The placement writer can create durable placement identity and wake a Container.
It therefore cannot be enabled by an ordinary configuration edit or by a
campaign request authenticated only as root. This contract adds a separate,
short-lived, single-use Ed25519 authorization that binds one exact staging
Controller candidate and one exact activation campaign.

The boundary has four independent layers:

1. an external Authority process approves and signs one canonical permit;
2. the edge Worker verifies the permit against deployment-pinned public trust;
3. D1 atomically consumes the permit before creating its campaign; and
4. the Controller and final placement trigger require the consumed permit
   before any Durable Object lookup, wake, or placement append.

Only layers 2-4 are implemented. The repository's offline JavaScript verifier
is a cross-runtime reference and release test. It is not an Authority service
and cannot authorize a Cloudflare mutation.

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

## Required Authority And Runner

Production readiness still requires a separate staging Authority and
deployment runner. The Authority must:

1. pin its policy and public approval keys outside caller input;
2. require distinct security, operations, release, and rollback approvals;
3. bind the exact immutable Controller deployment version, source/provenance,
   runtime build, gate inventory, foundation manifest, ring, shard count,
   campaign ID, and expiry;
4. issue one permit only after the exposed historical credential is revoked
   and replacement credential scopes are independently reviewed;
5. persist a create-only issuance/revocation audit without private material;
6. support key rotation and emergency revocation; and
7. expose a bounded read-only receipt for an independent verifier.

The deployment runner must pin the Authority trust identity, use separate
least-privilege read and deploy credentials, consume one execution nonce,
deploy Controller before edge, perform zero-retry writes, classify response
loss through authenticated version readback, and never enable production
placement gates. It must restore both staging writer gates to false after the
campaign, even when collection or rollback fails.

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
8. deploy the exact staging Controller version with both writer gates true;
9. run one default-jurisdiction N/N activation campaign and collect stable
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

A staging campaign is `proven` only when the permit, D1 authorization row,
campaign, N/N 0054 activations, N/N 0055 consumptions, N/N 0061 placements,
N/N 0062 events, Controller deployment, runtime image, and before/after
snapshots all bind the same candidate. The P5 collector does not yet ingest
the 0063 authorization row, so P5 remains incomplete even though runtime
consumption is implemented.

Rollback means disabling both writer gates, retaining the immutable failed
campaign and authorization, preventing new wakes, preserving Go/VPS authority,
and starting a new version/campaign/permit if another attempt is approved.
It never means deleting or rewriting 0063, 0062, 0061, 0055, or 0054 evidence.

## Local Verification

The local gate covers:

- canonical Ed25519 verification in Rust and JavaScript;
- fixed-vector parity and signed-field tampering;
- malformed SPKI/signature and trust mismatch;
- lifetime, skew, remaining-time, and replay identity limits;
- D1 missing, mismatch, production, replay, immutability, and placement guards;
- campaign authorization insert/readback ordering;
- Controller schema/readback validation before Durable Object lookup; and
- Worker/Controller configuration default-off behavior.

These tests prove local implementation consistency only. They do not prove
Cloudflare account state, credential rotation, remote D1 schema, an Authority
deployment, a live signature, a writer-enabled version, a Container wake, P5,
customer traffic, billing, Go/VPS drain, DNS cutover, or production readiness.

The complete repository gate passes with exit code 0 in 849.1 seconds. The
focused authorization gate passes 15 Bun tests and 22 Rust tests; Controller
portable/runtime suites pass 178 and 46 tests; the DO runtime suite passes 53
tests; the Worker library passes 872 tests; and the WASM target check passes.
SQLite independently proves 63 migrations, 72 tables, 962 checked incremental
columns, and 105 key indexes. Existing Rust `dead_code` findings remain
warnings only.
