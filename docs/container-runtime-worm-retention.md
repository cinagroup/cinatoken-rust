# Container Runtime R2 Retention Evidence

## Status

The repository implements the credential-free, fail-closed verifier contract
and the first credentialed staging collector boundary for the container-runtime
S3 immutable-retention subgate. The collector can prove an empty
content-addressed prefix and can configure/read back one exact-prefix bucket
lock, but no live phase has been run. The repository does not yet contain a
real staging R2 evidence bundle or authorize production mutation.

Current decision:

- S3 cryptographic evidence: accepted for the frozen subject.
- R2 retention contract: implemented and locally tested.
- R2 B1/B3 staging collector and lock identity preflight: implemented and
  locally tested; not executed against Cloudflare.
- Lock-operator lifecycle revoke/operator-readback/independent-readback
  collector: implemented and locally tested; not executed against Cloudflare.
- Final retention policy/trust/manifest/evidence verifier v2: implemented and
  locally tested with six identities and two complete writer-revocation
  evidence records.
- B4 create-only six-object publication and independent full readback
  collector: implemented and locally tested; not executed against Cloudflare.
- B2 credential issuance, revocation, and independent revocation readback:
  incomplete until real permission inventories, live receipts, canonical v2
  evidence assembly, and approval exist.
- B5 overwrite/delete probes, publisher lifecycle revocation, post-probe
  readback, and final lock readback collector: implemented and locally
  tested; not executed against Cloudflare.
- Canonical v2 evidence assembly and operations/security approval: not yet
  implemented.
- Real R2 bucket-lock evidence: not collected.
- `wormRetentionVerified`: false.
- `s3Complete`: false.
- Registry, Cloudflare staging, P5, traffic, and cutover: unauthorized.

Go/VPS remains authoritative and production remains **NO-GO**.

## Contract Scope

The verifier proves one narrow claim from a complete evidence bundle:

> At one bounded ceremony time, the exact retained provenance objects were
> present under a content-addressed Cloudflare R2 prefix, a qualifying bucket
> lock was read back, overwrite and delete were rejected by the provider, all
> write credentials were revoked in the required order, and two independent
> trusted roles approved the canonical evidence digest.

It does not prove regulatory legal hold, AWS S3 Object Lock compatibility,
future Cloudflare account-owner behavior, registry publication, image
signature, Cloudflare Container deployment, customer traffic safety, billing
correctness, P5 eligibility, or production cutover.

The output decision scope is
`cloudflare-r2-bucket-lock-retention-only`. A passing result may set
`wormRetentionVerified=true` and `s3Complete=true` only for the exact statement
digest, commit, bucket, jurisdiction, prefix, policy, and ceremony in the
manifest. Every downstream authority remains false.

## Repository Components

| File | Purpose |
| --- | --- |
| `config/container-runtime-worm-retention-policy.json` | Immutable repository protocol floor |
| `tools/verify_container_runtime_worm_retention.mjs` | Offline evidence verifier and credential-free contract audit |
| `tests/container-runtime-worm-retention-gate.test.mjs` | Positive fixture and fail-closed mutation suite |
| `tools/lib/container_runtime_worm_staging.mjs` | Injectable baseline/lock collection state machine |
| `tools/collect_container_runtime_worm_staging.mjs` | Default-dry-run staging CLI and AWS SDK v3/Cloudflare adapters |
| `tests/container-runtime-worm-staging-collector.test.mjs` | Pagination, authority separation, mutation, redirect, drift, and redaction tests |
| `tools/lib/container_runtime_worm_lifecycle.mjs` | Injectable account-token revoke and independent readback state machine |
| `tools/collect_container_runtime_worm_lifecycle.mjs` | Default-dry-run, predecessor-bound lifecycle CLI |
| `tests/container-runtime-worm-lifecycle-collector.test.mjs` | Receipt-chain, identity separation, DELETE/404, file, drift, and redaction tests |
| `tools/lib/container_runtime_worm_data.mjs` | B4 publication/readback plus B5 predecessor normalization |
| `tools/collect_container_runtime_worm_data.mjs` | Default-dry-run create-only publication and full readback CLI |
| `tools/lib/container_runtime_worm_receipt_file.mjs` | Shared stable, bounded, canonical, single-link receipt reader |
| `tools/lib/container_runtime_worm_enforcement.mjs` | Injectable five-phase positive B5 state machine plus two non-promotable emergency revocation phases |
| `tools/collect_container_runtime_worm_enforcement.mjs` | Default-dry-run SigV4 probe and lifecycle/readback CLI |
| `tests/container-runtime-worm-enforcement-collector.test.mjs` | Role isolation, raw response, chronology, lifecycle, readback, and file-boundary tests |
| `package.json` | Focused and aggregate verification entry points |

The protocol pins the repository, staging environment, Cloudflare R2 provider,
content-addressed prefix root, one-year minimum remaining retention, time
bounds, evidence/object inventories, signer workflow, GitHub OIDC identity,
builder identity, Cosign version and binary SHA-256, and official Cloudflare
capability references.

## Cloudflare Authority Model

Cloudflare currently separates object-only R2 credentials from R2
administrative permissions. Object Read and Object Read & Write can be scoped
to buckets and are supported only by the S3-compatible API. Bucket
configuration requires R2 Admin permissions. R2 Admin Read & Write also
includes object read/write; the lock operator therefore cannot truthfully be
modeled as lock-only.

The retention data-plane contract requires four distinct R2 credential
identities:

| Role | Cloudflare permission shape | Required capability evidence | Revocation |
| --- | --- | --- | --- |
| Publisher | R2 Object Read & Write, scoped to the evidence bucket | Object read/write; no lock API | Provider-confirmed after overwrite/delete probes and before final readback |
| Lock operator | R2 Admin Read & Write | Object and lock read/write, as the platform actually grants | Provider-confirmed after lock setup and before the first upload |
| Object verifier | R2 Object Read only, scoped to the evidence bucket | Object read/list only | Read-only during the decision |
| Lock verifier | R2 Admin Read only | Object read/list and lock read; no writes | Read-only during the decision |

Every credential is represented only by a SHA-256 identifier, exact permission
facts, bounded expiry, and, for writers, a separate redacted lifecycle evidence
record. Secret values, raw access key IDs, Authorization headers, raw
request/response bodies, cookies, and private keys are prohibited from the
bundle.

Credential identity is provider-derived, not secret-derived. Cloudflare
documents that an R2 S3 Access Key ID is the API token ID, while the Secret
Access Key is derived from the token value. The baseline receipt therefore
hashes the publisher Access Key ID. Before any lock read or mutation, the lock
phase calls `GET /accounts/{account_id}/tokens/verify` with the lock-operator
token and hashes the returned provider token ID. `credentialIdSha256` must
never be a hash of the API token secret. This common provider-ID domain is the
cross-phase identity bridge needed to join S3 observations, Cloudflare token
lifecycle receipts, and authority-separation checks without disclosing a raw
credential identifier.

This semantic change is encoded as staging phase receipt schema/contract v2.
Version 1 receipts used a different lock credential digest meaning and must
not be mixed with or upgraded implicitly to v2.

Token lifecycle is a separate control plane. Account-token read/edit is
non-R2 authority and must not be granted to the publisher, lock operator,
object verifier, or lock verifier. The lifecycle process uses two additional
reviewed identities:

| Role | Intended permission shape | Runtime process |
| --- | --- | --- |
| Lifecycle operator | Account-token lifecycle read plus edit only; no R2 permission | Self-verify, delete the exact lock-operator provider token ID, then read the exact resource as absent |
| Lifecycle verifier | Account-token lifecycle read only; no R2 permission | Self-verify under a distinct provider token ID, then independently read the same target as absent |

The collector cannot infer permission policy from token self-verification.
Real permission inventory and independent review therefore remain mandatory.
Final verifier v2 requires all six identities in exact order, exact normalized
permission inventories and capability matrices, account-only scope for both
lifecycle roles, zero lifecycle authority in every R2 role, and no R2
authority in either lifecycle role. Each credential must expire after the
decision but within 3600 seconds of authority capture. Local fixture success
or two synthetic 404 responses are not B2 completion.

The lock operator's unavoidable object authority is bounded by ceremony
ordering: configure and read back the lock, revoke the operator, then publish.
The publisher is revoked after provider-side enforcement probes. No write
credential may remain active when the final readbacks and signed decision are
created.

## Evidence Bundle

The trust policy must be a canonical JSON file outside the evidence bundle.
The bundle root contains:

```text
manifest.json
evidence/
  authority-boundary.json
  lock-operator-revocation.json
  object-readback.json
  enforcement-probes.json
  publisher-revocation.json
  lock-readback.json
objects/
  container-runtime-source-evidence.zip
  container-runtime-provenance-evidence.zip
  container-runtime.provenance.slsa.json
  container-runtime.provenance.sigstore.json
  container-runtime-provenance-verification.json
  cosign-verification.log
```

All JSON files use recursively sorted canonical JSON plus one trailing LF.
Manifest, trust, and evidence files must be bounded regular single-link files.
Object files are bounded regular single-link files, and the verifier rejects
symlinks, path escape, concurrent mutation, digest/size drift, excessive JSON
shape, unknown keys, incomplete inventories, duplicate identities, and
prohibited secret-bearing fields.

The R2 prefix is:

```text
container-runtime/s3/v1/<statement-sha256>/
```

Object keys and local readback filenames are exact. Each R2 object record binds
its key, byte count, SHA-256, ETag, exact content type, upload/readback time,
upload/readback HTTP status and provider request IDs, and custom metadata for
contract, repository commit, and digest.
The baseline and final listings must be fully paginated, with zero preexisting,
multipart, or unknown objects. Uploads must be create-only.

## Trust And Approval

The external trust policy binds:

- the canonical protocol-policy SHA-256;
- repository, environment, provider, account-ID SHA-256, bucket,
  jurisdiction, and prefix root;
- equal or stronger retention and time bounds;
- distinct Ed25519 public keys for `operations` and `security`.

The trust policy contains public material only. It must not be stored inside
the evidence bundle.

The manifest subject is canonicalized and hashed. Both roles sign the exact
message:

```text
cinatoken-container-runtime-worm-retention-anchor-v2
<policy-id>
<manifest-subject-sha256>
```

Each line, including the last, ends with LF. Approval order is exact:
`operations`, then `security`. Duplicate key IDs, duplicate public keys,
wrong roles, invalid validity windows, malformed Ed25519 keys, and forged
signatures fail closed.

## Ceremony Order

1. Freeze the exact source run, signer run, commit, source packet, provenance
   packet, statement, bundle, report, Cosign log, and seven signed subjects.
2. Create or select the dedicated staging evidence bucket and verify the
   exact account, bucket, jurisdiction, owner, and empty content-addressed
   prefix.
3. Issue four distinct short-lived R2 credentials plus separate lifecycle
   operator and lifecycle verifier credentials with the exact permission
   inventories above. Keep all values in approved secret channels only.
4. Use `GET /accounts/{account_id}/tokens/verify` to bind the lock operator to
   its provider token ID, require active status, require an already-active
   validity window, and require no more than 3600 seconds of remaining
   lifetime.
5. Use the verified lock operator to set an exact-prefix Age, Date, or
   Indefinite rule through
   `PUT /accounts/{account}/r2/buckets/{bucket}/lock`, then read the complete
   configuration back.
6. Revoke the lock operator through the independent lifecycle control plane
   and independently read back provider state proving that exact token ID is
   no longer usable before uploading any object.
7. Upload the six exact objects with create-only semantics. Reject a
   preexisting key or unresolved multipart upload.
8. Use the object verifier to list all pages and download every object.
   Recompute every digest and byte count.
9. Use the publisher first for a create-only preflight against the retained
   key. Exact `412 PreconditionFailed` proves that the B4 publisher identity
   is still accepted and that the key already exists; it is not retention
   evidence. Then send an unconditional different-content overwrite and an
   unconditional deletion. The reviewed staging policy currently requires
   exact `403 AccessDenied` for both operations, XML response media, raw-body
   hashes, byte counts, completion times, and provider request IDs.
10. Revoke the publisher after both probes through the lifecycle control
    plane, independently verify revocation of its provider token ID, and use
    the object verifier to prove the original object remains byte-identical.
11. Use the lock verifier to read the complete lock configuration after the
    probes and writer revocations.
12. Build the six canonical evidence documents and v2 manifest. Operations
    and security independently inspect and sign the subject digest.
13. Run the offline verifier from a clean host with the trust policy supplied
    separately. Preserve its JSON output as the S3 decision receipt.

For an Age rule, the earliest per-object retention deadline must still be at
least one year after the manifest decision time. For a Date rule, the date
must satisfy the same minimum. Indefinite is accepted. The selected rule must
be enabled and match the exact content-addressed prefix.

## Staging Collector Boundary

The staging collector deliberately exposes two separate live processes:

| Phase | Credential read | Network behavior | Mutation |
| --- | --- | --- | --- |
| `baseline` | `CINATOKEN_WORM_PUBLISHER_R2_ACCESS_KEY_ID` and `CINATOKEN_WORM_PUBLISHER_R2_SECRET_ACCESS_KEY` | Exhausts `ListObjectsV2` and `ListMultipartUploads` for the exact prefix | None |
| `lock` | `CINATOKEN_WORM_LOCK_OPERATOR_API_TOKEN` | `GET` token self-verification first, then `GET` current lock configuration, `PUT` the reviewed rule set, and `GET` final configuration | One bucket-lock configuration update; no token revocation |

One invocation can read only one role's credential variables. Baseline uses
the pinned AWS SDK v3 R2 S3 endpoint, checks every page and continuation
marker, rejects prefix escape, common prefixes, existing objects, multipart
uploads, contradictory pagination, and unbounded inventories. If the SDK does
not expose a provider request ID, the receipt records `null` and
`providerRequestIdsComplete=false`; it never invents provider correlation.

The lock phase uses the Cloudflare API directly with manual redirects, bounded
time/body, exact JSON envelope and rule schemas, and mandatory `cf-ray`
correlation. Its first request is
`GET /accounts/{account_id}/tokens/verify`. The response must contain a valid
provider token ID, active status, an expiry, an effective `not_before` when
present, and a remaining lifetime from 1 through 3600 seconds. The receipt
stores SHA-256 of that provider token ID plus the verification time, expiry,
and remaining lifetime; it never hashes or emits the token secret as
`credentialIdSha256`.

After preflight, the phase preserves unrelated existing lock rules, rejects
duplicate IDs and ambiguous reruns, appends one deterministic Age rule for the
statement digest, and requires exact `PUT` plus final `GET` equality. A
reflected token, redirect, unknown field, missing correlation ID, inactive or
overlong credential, status drift, or readback mismatch fails closed.

No invocation writes files. Stdout is one canonical redacted phase receipt.
Unexpected provider exceptions are converted to controlled messages. Access
keys, secret keys, API tokens, Authorization headers, and the raw account ID
are absent from output. Credential values must arrive through the environment
from an approved secret broker; they are never accepted in argv.

Every dry-run and live phase receipt keeps
`lockOperatorRevocationVerified=false`,
`publisherRevocationVerified=false`, `wormRetentionVerified=false`,
`s3Complete=false`, `formalP5Evidence=false`, customer traffic false, and
production cutover false. The receipts are inputs to a future ceremony
assembler, not verifier-compatible final evidence by themselves.

Self-verification is identity and lifetime evidence only. It is not issuance
review, least-privilege proof, revocation, or independent revocation readback.
The lifecycle collector below can collect the revoke/readback sequence, but
it cannot prove the reviewed account-token read/edit permission inventory or
independently assemble and sign the final v2 evidence bundle. B2 remains
incomplete and no collector receipt can authorize production.

## Lifecycle Collector Boundary

The lifecycle collector consumes canonical predecessor files rather than raw
claims:

| Phase | Canonical predecessor | Credential environment | Provider operations |
| --- | --- | --- | --- |
| `revoke` | Live staging lock receipt contract v2 | `CINATOKEN_WORM_LIFECYCLE_OPERATOR_API_TOKEN` plus `CINATOKEN_WORM_LIFECYCLE_TARGET_API_TOKEN_ID` | Operator self-verify `200`, exact target DELETE `200`, exact target GET `404` |
| `verify` | Live lifecycle revoke receipt contract v1 | `CINATOKEN_WORM_LIFECYCLE_VERIFIER_API_TOKEN` plus the same target ID | Verifier self-verify `200`, exact target GET `404` |

Predecessor files must be bounded regular single-link files, opened with
no-follow semantics, stable across the read, UTF-8, shape-bounded, and exact
canonical JSON plus one LF. The lifecycle library validates the complete lock
receipt target, credential, facts, selected one-year rule, operation sequence,
limits, time order, and downstream-false state. It hashes the complete
canonical predecessor file bytes, including the LF.

The target token ID is accepted only through the environment and must hash to
the provider-ID digest in the predecessor. Lifecycle operator, target, and
lifecycle verifier provider IDs must all be distinct. Both lifecycle
credentials must be active, already effective, explicitly expiring, and have
1 through 3600 seconds of remaining lifetime. The recorded remaining-lifetime
field must exactly equal the floored expiry/verification-time delta.

An absence observation is accepted only on the generated account-token
resource URL. The revoke phase must first receive an exact DELETE `200` result
containing the same target ID. Its GET and the independent verifier GET must
both return exact `404` JSON envelopes, valid `cf-ray` values, bounded body
hashes, and the same numeric error-code sequence. Bodies and messages are not
emitted. A redirect, another status, unknown envelope/error field, ID
reflection during either absence response, request-ID drift, body-hash drift,
time reversal, or credential overlap fails closed.

This is still collection substrate. The receipt intentionally retains every
downstream authority flag as false because it does not prove the reviewed
permission inventory, signer custody, live staging ownership, canonical v2
evidence assembly, or independent approvals.

## Provider Enforcement Requirements

Overwrite and delete probes are evidence only when:

- the same B4 publisher first receives the pinned create-only preflight tuple;
- overwrite and delete carry no conditional request guard;
- the transport completed;
- the provider, rather than a client guard, rejected the operation;
- each result exactly matches the reviewed operation-level status/error tuple;
- a provider request ID and source, error code, response-body SHA-256, response
  bytes, content type, attempt time, and completion time exist;
- an XML `RequestId`, when present, matches the `x-amz-request-id` header;
- overwrite attempted different non-empty content;
- delete targeted the exact original object;
- a later readback matches the original SHA-256, bytes, and ETag;
- the final lock readback occurs after the probes and final object readback.

Authentication/signature errors, permission drift, 409/412 on the actual
overwrite, timeouts, 408, 425, 429, 404, 5xx, redirects, retries, local policy
denial, missing or conflicting request IDs, malformed/unsafe XML, successful
writes/deletes, stale lock reads, and object drift are ambiguous and fail
closed.

Cloudflare documents the lock outcome, not a stable failure tuple. The
repository's `403 AccessDenied` tuple is therefore a reviewed ceremony policy,
not a platform guarantee. Before the first live run, operations/security must
calibrate it in a disposable non-evidence prefix using the exact publisher
permission shape and archive the approved result. Any provider drift requires
a policy/code review; operators must not widen the allowlist during a
ceremony.

## Retained Provenance Revalidation

The verifier does not trust the retained report by itself. It independently
revalidates:

- both GitHub artifact digests and distinct source/signer run IDs;
- exact commit, `main` ref, and `push` or `workflow_dispatch` source event;
- the exact seven OCI/runtime/SBOM/vulnerability statement subjects;
- SLSA statement type, predicate, build type, builder, and canonical bytes;
- exact provenance workflow identity and GitHub OIDC issuer;
- pinned Cosign v3.1.2 and Linux AMD64 binary SHA-256;
- Sigstore bundle v0.3, byte-identical DSSE payload, one signature, Fulcio
  certificate, SCT, Rekor promise/proof, and signed timestamp;
- exact `Verified OK\n` Cosign log;
- the original report's cryptographic-pass/WORM-pending decision and all
  downstream false values.

A retained report that already claims WORM, complete S3, registry authority,
Cloudflare deployment, P5, traffic, or production is rejected.

## Commands

Credential-free contract audit:

```powershell
npx.cmd --yes bun run check:container-runtime:worm-retention-contract
npx.cmd --yes bun run check:container-runtime:worm-staging-collector
npx.cmd --yes bun run check:container-runtime:worm-lifecycle-collector
npx.cmd --yes bun run check:container-runtime:worm-data-collector
npx.cmd --yes bun run check:container-runtime:worm-enforcement-collector
```

Collector description and credential-free dry-run:

```powershell
node tools/collect_container_runtime_worm_staging.mjs
node tools/collect_container_runtime_worm_lifecycle.mjs
node tools/collect_container_runtime_worm_data.mjs
node tools/collect_container_runtime_worm_enforcement.mjs

node tools/collect_container_runtime_worm_staging.mjs `
  --phase baseline `
  --account-id <32-hex-account-id> `
  --bucket <dedicated-staging-bucket> `
  --jurisdiction <default-or-eu-or-fedramp> `
  --statement-sha256 <statement-sha256>
```

`--phase lock` produces the lock request plan. A phase remains dry-run unless
`--live` is explicitly present. Baseline live execution additionally requires
`--confirm-staging-target --confirm-readonly-baseline`; lock live execution
requires `--confirm-staging-target --confirm-lock-mutation`. A secret broker
must inject only the environment variables named for that phase.

Real evidence verification:

```powershell
node tools/verify_container_runtime_worm_retention.mjs `
  --manifest C:\approved-evidence\manifest.json `
  --trust-policy C:\approved-trust\worm-retention-trust-policy.json `
  --json
```

`--now` exists only for deterministic replay and must be an RFC3339
timestamp. `--self-test` is mutually exclusive with evidence inputs.

The self-test confirms repository structure and negative-test coverage. It
always reports remote evidence, storage mutation, WORM, complete S3, registry,
Cloudflare deployment, P5, traffic, and production as false.

## Platform Limitation

Cloudflare documents that bucket-lock rules can be updated or removed. Bucket
locks prevent object overwrite/deletion while matching rules are active, but
they are not AWS S3 Object Lock, legal hold, or governance/compliance mode.

For this migration, `wormRetentionVerified=true` means the bounded,
contract-specific ceremony above passed with provider enforcement, revoked
writers, and an independent signed anchor. It must not be marketed or audited
as regulatory immutable storage without a separately approved control and
legal/compliance determination. If that stronger property is required, select
an external storage provider/control that supplies non-bypassable retention
and keep this R2 receipt as a secondary operational record.

## Final Verifier V2 Boundary

Verifier v2 rejects every v1 protocol policy, trust policy, manifest, and
evidence envelope. Its authority evidence requires six distinct provider-ID
digests, exact permission inventories, exact scope/capability matrices, and a
maximum 3600-second credential lifetime at decision capture.

Two separate lifecycle evidence records are mandatory:

- `lock-operator-revocation` must follow lock configuration and complete
  before the first upload;
- `publisher-revocation` must follow both enforcement probes and complete
  before the post-probe object readback.

Each record binds the target, lifecycle operator and lifecycle verifier
provider-ID digests; account-token API surface; canonical target-binding
digest; distinct predecessor/revoke/verify receipt-file digests; exact DELETE
`200`; operator GET `404`; independent verifier GET `404`; three distinct
provider request IDs; response-body hashes; matching bounded error-code
sequences; credential expiry; and strict timestamps. Only a complete signed
bundle may set `lockOperatorRevocationVerified=true`,
`publisherRevocationVerified=true`, `wormRetentionVerified=true`, and
`s3Complete=true` for its exact subject.

The focused verifier passes 11 tests with 217 expectations. The staging
policy-v2 integration passes 16 tests with 110 expectations, and the complete
eight-suite container supply-chain set passes 92 tests with 854 expectations.
The complete repository gate passes with exit code 0 in 611.2 seconds; 21
existing Rust `dead_code` findings remain warnings only.

## B4 Data Collector Boundary

`tools/collect_container_runtime_worm_data.mjs` implements two isolated
phases under contract
`cinatoken-container-runtime-worm-data-phase-receipt-v1`:

1. `publish` accepts one canonical, single-link B1 baseline receipt and one
   canonical, single-link B3 lock-revocation verifier receipt. It requires
   exact target equality and strict baseline -> lock -> revoke -> independent
   readback ordering before it reads the publisher credential.
2. The artifact directory must contain exactly the six retained object
   filenames. Each regular, single-link file is held open, bounded to 512 MiB
   with a 768 MiB aggregate limit, SHA-256/MD5 hashed, and re-statted after
   publication.
3. Every upload is a single `PutObject` with `If-None-Match: *`, exact content
   length/type, `Content-MD5`, v2 contract/commit/SHA-256 metadata, one
   provider request ID, and one ETag. No S3 Object Lock header is used.
4. `readback` requires a canonical publish receipt and a distinct
   object-verifier access-key digest. It exhausts `ListObjectsV2` and
   `ListMultipartUploads`, rejects missing/extra/duplicate objects or any
   multipart residue, then downloads each object with its exact ETag in
   `If-Match`.
5. Download bodies are streamed into an operator-supplied empty directory.
   Each `.partial` file is bounded and SHA-256 checked before an atomic
   no-overwrite hard-link promotion, directory-set verification, and a second
   stable-file digest pass.

The official R2 S3 compatibility table currently marks `PutObject`
`If-None-Match`, `GetObject` `If-Match`, `ListObjectsV2`,
`ListMultipartUploads`, and `DeleteObject` as implemented. Cloudflare's
Bucket Lock documentation states that matching rules prevent both overwrite
and deletion. The collector nevertheless treats these as protocol
assumptions to be proven by real provider receipts; local fixtures cannot
establish provider behavior.

Both dry-run and self-test read no credentials, make no request, write no
file, and keep every downstream authority false. The focused B4 gate passes
11 tests with 76 expectations. The lifecycle gate passes 18 tests with 115
expectations after all B3-to-B4 chronology boundaries were made strictly
ordered. The nine-suite container supply-chain aggregate passes 104 tests
with 938 expectations. The complete repository gate passes with exit code 0
in 604 seconds; 21 existing Rust `dead_code` findings remain warnings only.

## B5 Enforcement Collector Boundary

`tools/collect_container_runtime_worm_enforcement.mjs` consumes the exact B4
publish/readback and B3 lock-revocation chain through five independently
credentialed positive phases plus two independently credentialed emergency
phases:

| Phase | Credential | Required provider behavior |
| --- | --- | --- |
| `probe` | B4 publisher R2 key | Create-only preflight, one unconditional overwrite, then one unconditional delete through raw SigV4 fetch |
| `revoke` | Lifecycle operator | Self-verify, delete the exact B4 publisher token, operator-side exact-resource `404` |
| `verify-revocation` | Lifecycle verifier | Independent self-verify and exact-resource `404` |
| `object-readback` | B4 object verifier | `GetObject` with the original ETag in `If-Match`, streamed digest/size proof |
| `lock-readback` | Sixth, independent lock verifier | Self-verify and read the complete original rule set after object readback |
| `emergency-revoke` | Lifecycle operator | Bind an incident-artifact SHA-256, revoke the B4 publisher without a positive probe receipt, then operator-side exact-resource `404` |
| `emergency-verify` | Lifecycle verifier | Independently verify exact-resource `404`; receipt is permanently ineligible for positive evidence |

Each invocation reads only its role's environment variables. The probe
transport is raw SigV4 rather than the AWS SDK error abstraction: it sends
exactly one request per operation, forbids redirects, bounds each response to
1 MiB, validates strict UTF-8/XML with DTD/entity rejection, binds the parsed
error to the raw body and provider request header, and records start plus
completion times. Predecessors use the shared stable canonical receipt reader
with no-follow, single-link, exact-length, front/back stat, path/inode, JSON
shape, and canonical-LF checks.

The complete known identity set is distinct before mutation, and the final
lock phase proves all six provider-ID digests are distinct. Publisher
revocation begins only after all probe responses complete; post-probe object
readback follows independent revocation verification; final lock readback
follows object readback. Every B5 receipt remains non-authoritative.

An ambiguous or unsafe probe chain cannot produce the positive predecessor
required by `revoke`. The emergency pair instead starts directly from the
canonical B3/B4 chain and an operator-retained incident-artifact digest. Both
receipts set `emergency=true`, `positiveEvidenceEligible=false`, and every
downstream flag false; positive normalizers reject them.

The focused B5 gate passes 18 tests with 91 expectations. Its credential-free
self-test passes seven cases with 22 invariants. B4 passes 11 tests
with 78 expectations, B3 passes 18 tests with 115 expectations, final
verifier v2 passes 11 tests with 274 expectations, and staging passes 16 tests
with 110 expectations. The ten-suite container supply-chain aggregate passes
122 tests with 1088 expectations. The complete repository gate passes with
exit code 0 in 629.4 seconds; 21 existing Rust `dead_code` findings remain
warnings only.

## Next Execution Unit

The next implementation is B6/B7 offline assembly: consume the complete
B1-B5 receipt chain, independently revalidate all receipt bytes/digests and
reviewed permission inventories, emit the six canonical v2 evidence records
plus manifest, then require separate operations/security signatures and a
clean-host verifier replay. B6/B7 tooling must remain credential-free and
must not infer authority from a collector receipt.

Collector self-tests and dry-runs are not real evidence. The lock phase must
not be run until the dedicated bucket, four ephemeral R2 credentials,
separate lifecycle authority and independent revocation-readback owner,
approval keys, artifact packet, and abort/cleanup runbook have independent
review. The identity-preflight and lifecycle implementations have passed
focused and aggregate local verification; the complete repository gate passes
with exit code 0 in 611.2 seconds. No lifecycle phase has run against
Cloudflare. Registry R3 remains blocked until a complete real bundle passes
verifier v2. B2 is not complete, Go/VPS remains
authoritative, and production remains **NO-GO**.

Primary references:

- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [Cloudflare R2 authentication and permissions](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Cloudflare account-owned API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
- [Cloudflare API-token lifecycle permissions](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)
- [Cloudflare TypeScript bucket-lock API at audited commit](https://github.com/cloudflare/cloudflare-typescript/blob/3583affb5cea551858ed4c4b6c0fc326a306d3bd/src/resources/r2/buckets/locks.ts)
