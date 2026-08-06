# JSON Compatibility External WORM Archive

## Decision And Scope

The JSON compatibility campaign requires an evidence archive outside the
Cloudflare deployment trust domain. C2 is satisfied only by a provider control
that gives every retained object a version-specific, compliance-mode retention
deadline and prevents privileged deletion or retention shortening until that
deadline. The minimum remaining retention is 365 days.

Cloudflare R2 remains useful as the private Source Verifier retrieval cache and
as an operationally locked secondary copy. It is not the C2 authority:

- [R2 Bucket Locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
  can prevent overwrite and deletion while a rule is present, but the rule set
  is itself replaceable or removable through the Cloudflare control plane.
- [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
  explicitly does not implement `PutObjectLockConfiguration`,
  `GetObjectLockConfiguration`, `x-amz-object-lock-mode`,
  `x-amz-object-lock-retain-until-date`, or legal-hold headers.
- R2 `Indefinite` bucket lock is not promoted to S3 Object Lock compliance mode
  or to a legal hold.

The first reviewed provider adapter targets Amazon S3 Object Lock. The
provider-neutral contract does not permit an adapter to self-declare
equivalence. A new provider requires a versioned adapter, capability review,
negative fixtures, and an independently approved backend policy digest.

This repository can implement and test the protocol without credentials. A
passing local suite, dry-run, or GitHub Action does not prove that an external
bucket, retention policy, object version, or provider identity exists.

## Trust Domains

The archive ceremony has four isolated roles. One process, runner identity,
credential, signing key, writable output prefix, or operator must not collapse
these roles.

| Role | Authority | Forbidden authority |
| --- | --- | --- |
| Retention administrator | create and independently approve the external bucket/versioning/Object Lock baseline | source collection, object publication, source signing, campaign mutation |
| Archive writer | create each exact object version once with compliance retention | readback attestation, delete, retention bypass/shortening, Cloudflare access |
| Independent reader | read exact versions, retention state, bytes and metadata | put, delete, copy, retention mutation, Cloudflare access |
| C4 source signer | verify the complete C1-C3/C2 closure and sign the transition-bound source subject | archive mutation, Cloudflare collection/deployment credentials |

The writer and reader use separate short-lived provider sessions and separate
Ed25519 attestation keys. Their trust-policy digests are approved outside the
archive manifest. Embedded SPKI bytes are verification material, not trust
anchors. C1 Cloudflare credential keys, C2 writer/reader keys, and the C4 source
signer key use different domains and are never interchangeable.

## Evidence Graph

```text
two C1-approved Cloudflare collection passes
  -> create-once raw capture manifests, page bodies and page receipts
  -> terminal closure for each capture directory
  -> stable account-binding evidence and inventory projection
  -> C2 archive policy + exact canonical archive manifest
  -> writer-signed provider write observations
  -> independent reader-signed exact-version observations
  -> credential-free C2 archive evidence closure
  -> C4 source signature
  -> create-once R2 retrieval bundle
  -> private Source Verifier
```

The WORM archive contains the evidence that exists before C4 signs. Archiving
the final C4 bundle is allowed as a later evidence copy, but its receipt cannot
be an input to the C2 closure that the bundle signs. That would create a digest
cycle.

## Canonical Archive Policy

The externally approved policy binds:

- environment, provider control type, backend and namespace identity digests;
- externally reviewed backend and namespace identity digests;
- compliance retention with a 31,536,000-second minimum;
- five-second minimum and 900-second maximum independent-readback delay;
- distinct writer and reader principal, credential, custodian, operation and
  attestation-key requirements;
- a read-only reader permission-set digest;
- exact writer and reader Ed25519 key IDs/SPKI digests plus principal,
  credential and permission-set identities;
- an effective time and canonical policy digest; and
- an explicit statement that Cloudflare R2 bucket-lock evidence is not an
  accepted C2 backend.

Compliance retention and legal hold are separate controls. C2 requires
compliance retention. A legal hold can be required by a later policy, but it
cannot replace the fixed retention deadline and is never inferred from an
indefinite R2 rule.

## Archive Manifest

The manifest is a canonical, create-once closure over the exact source set. It
contains no credential, raw account ID, provider secret, local absolute path,
or reversible secret representation. Its context binds:

- archive operation, policy, account, Plan v5 and state-plan v2 digests;
- collection profile, collector identity and C1 provenance digests;
- collection and independent-readback artifact, snapshot, authentication,
  page-chain, credential-receipt and custodian roots;
- transition and optional phase source-manifest digests;
- all-18-artifact readback, account-binding evidence and exact inventory
  projection digests; and
- creation time, object count, total bytes and ordered object-set digest.

The object set contains, at minimum:

1. Plan and deployment state plan;
2. collection profile and collector identity;
3. C1 trust/revocation/provenance material retained without credentials;
4. both raw capture manifests and terminal closures;
5. every raw response body and corresponding page receipt from both passes;
6. both terminal collection artifacts;
7. stable account-binding evidence and its exact inventory projection;
8. transition and optional phase source manifests; and
9. the all-18-artifact independent readback.

Every descriptor binds logical role, pass mode, sequence/resource family when
applicable, content type, byte length, body SHA-256 and digest-addressed object
key. Each page receipt appears exactly once and has exactly one retained body
and one retained receipt. Missing, duplicate, extra, reordered, path-escaping,
or digest-detached members fail closed.

The contract caps one archive at 512 descriptors and 768 MiB of retained
content. The descriptor cap is deliberately below the Source Verifier's
12 MiB canonical-bundle and 200,000-node limits, so a C2-valid archive cannot
become structurally unverifiable only after it reaches the Worker.

The canonical manifest is the root over the payload object set and therefore
cannot include its own body digest as an ordinary member. Contract v1 retains
that root inside the dual-signed C2 evidence and the C4 bundle, but it does not
yet claim a separate provider observation for a manifest object. Production
C2 remains open until a non-self-referential manifest-root publication and
independent readback receipt are retained alongside the payload observations.

## Provider Write Contract

The Amazon S3 adapter is intentionally narrower than a general S3 client:

- the target uses an exact region, expected bucket owner and bucket identity;
- SDK retries are disabled (`maxAttempts=1`);
- each `PutObject` uses `If-None-Match: *`;
- each request supplies `ObjectLockMode=COMPLIANCE`, the exact
  `ObjectLockRetainUntilDate`, `ChecksumSHA256`, content length/type and
  digest-bound metadata;
- every successful response must contain HTTP 200, a provider request ID,
  object `VersionId`, ETag and matching checksum evidence; and
- every payload member is written exactly once under its manifest-derived key.

A timeout, connection loss, malformed response, provider error, or lost
response after a possible commit is `ambiguous`. The operation ID and object
prefix are consumed. The writer must not retry the same create call or infer
failure from the missing response; only an independent read-only recovery
operation may classify the result.

The normalized write subject binds every object key/version/ETag/body/length,
the requested compliance deadline, provider-request digests, the writer
principal and credential identities, policy and manifest roots, and the
complete chronology. It also binds the canonical SHA-256 of the complete raw
writer provider-observation array. It is signed under the writer-only C2
domain.

`tools/run_container_runtime_json_compatibility_external_worm_s3.mjs` exposes
one-object `publish` and `independent-readback` modes. It accepts only canonical
request/publication files, reads bodies as bounded binary data, reserves its
output create-once, persists `observed`, `ambiguous`, or `mismatch` provider
observations, performs no CLI retry, and never marks an observation as C2
closure. `--describe` and both `--dry-run` modes read no credentials or files
and issue no network request.

## Independent Readback Contract

The reader receives no writer secret and performs no mutation. Before object
reads it proves:

- bucket versioning reports `Enabled`;
- Object Lock reports `Enabled` for the exact expected owner/bucket; and
- the reader credential and attestation key are distinct from the writer.

For every exact `VersionId`, the reader performs a bounded full `GetObject`
and an exact-version `GetObjectRetention`. It verifies:

- key and version identity;
- full streamed byte length and SHA-256;
- ETag, checksum, content type and digest-bound metadata;
- `ObjectLockMode=COMPLIANCE`;
- retention response mode and deadline;
- no shorter deadline than the writer requested; and
- at least 365 days remaining at C4 issue time.

The readback starts after the writer completes and within the policy's
five-to-900-second window. Its subject binds the write-envelope digest and the
same complete ordered object set, provider request/response digests, reader
identity and chronology. It also binds the canonical SHA-256 of the complete
raw readback provider-observation array. It is signed under the reader-only C2
domain.

## Credential And Process Boundary

Live writer and reader modes use role-specific short-lived session variables.
They reject the opposite role, generic AWS credential variables, Cloudflare/
Wrangler credential variables, and any mixed-role environment before reading
archive files or performing a network request. Credentials are never accepted
through argv, canonical JSON, output receipts, logs or artifacts.

Production should obtain the short-lived role session through an approved OIDC
exchange. Static access keys are not an accepted production ceremony. The
provider session expiry must leave enough time for the bounded operation and
ambiguity recovery; expiry and credential-ID digest are included in the local
execution context without retaining the secret.

## C2 Closure And Source Verifier

The credential-free finalizer reconstructs policy, manifest, writer and reader
subjects, verifies both Ed25519 envelopes against independently supplied policy
anchors, and compares every ordered object observation. The retained closure
derives backend and namespace identities from the exact S3 region, bucket,
expected owner and object-key set, then maps each raw write/readback observation
to its C2 descriptor and signed C2 observation. It also checks:

- distinct principals, credentials, operations, custodians and signing keys;
- exact account/plan/transition/evidence roots;
- write-before-read and bounded chronology;
- provider capability and policy identity;
- compliance mode and minimum remaining retention;
- exact-version readback of every retained member; and
- exact raw writer/readback observation-set digests, credential roles,
  metadata, retention, chronology and non-reused provider request IDs; and
- no downstream cutover or deployment authority in any C2 receipt.

The resulting C2 evidence digest and S3 closure digest are inputs to the
immutable-source archive receipt and are transitively bound by the C4 source
signature. A production
Source Verifier bundle must carry the full C2 policy, manifest, signed write
receipt, signed readback receipt and closure. A legacy archive receipt with
only self-declared `external-worm`, `compliance`, timestamps and an opaque
retention digest is `legacy-unproven` and cannot authorize a transition.

The Source Verifier remains read-only. It does not receive archive provider,
Cloudflare, signer or deployment credentials, and it never calls the external
provider. It replays the retained canonical proof and verifies the C4 signature
against Worker configuration.

## Failure Matrix

| Failure | Required result |
| --- | --- |
| R2 bucket-lock receipt supplied as C2 | Reject before source signature verification |
| Governance mode, mutable lifecycle rule or unknown provider mode | Reject |
| Writer/reader identity, credential, operation or key reuse | Reject |
| Mixed credential environment | Reject before file or network access |
| Existing object or create precondition failure | Abort; do not overwrite |
| Put timeout or response loss | Mark operation ambiguous; never resend |
| Missing/extra/duplicate archive member | Reject manifest closure |
| Version, ETag, bytes, checksum or metadata drift | Reject readback |
| Raw provider observation changed outside its signed C2 set | Reject closure replay |
| Retention shortened by one second | Reject |
| Readback outside five-to-900-second window | Reject |
| C2 evidence changed without a new C4 signature | Reject signature |
| Provider audit evidence unavailable | Keep production C2 gate closed |

## Promotion Sequence

1. Freeze the exact repository commit, policy, adapter and archive operation.
2. Provision an isolated external bucket with versioning and Object Lock
   enabled; independently record the backend and policy identities.
3. Issue distinct short-lived writer and reader sessions through protected
   environments and named approval.
4. Assemble and locally verify the exact archive manifest from both completed
   account traversals.
5. Run the writer once and persist its create-once signed receipt.
6. Revoke or let the writer session expire; do not expose it to the reader.
7. Run exact-version independent readback and persist its signed receipt.
8. Collect and bind provider audit events with an independently authorized
   reader.
9. Run the credential-free C2 finalizer with external trust-policy digests.
10. Have the isolated C4 signer verify C1-C3/C2 and sign the source subject.
11. Publish the canonical retrieval bundle to R2 create-once and independently
    read it back through the private Source Verifier.
12. Only then evaluate the deployment leaf and transition campaign gates.

## Current Status

The repository now has terminally closed local raw capture, a strict C2
policy/manifest/object contract, dual-domain Ed25519 writer/readback evidence,
an Amazon S3 Object Lock data plane and create-once operator CLI, a v3 receipt
derived from full C2 evidence plus the raw S3 observation closure, and Source
Verifier replay pinned to an external policy digest. Local contract, fault and
Worker tests prove that terminal-body and provider-observation substitution
fail closed; they do not establish a real
bucket or retention deadline.

Still required are the reviewed external bucket/control-plane baseline,
short-lived independently held writer and reader sessions, real create-only
publication and exact-version readback, provider audit records, production key
custody/signatures, the C4 ceremony, create-once R2 publication/readback, and a
remote campaign. Cloudflare R2 remains only the retrieval cache. C2 remains
open, Go/VPS remains authoritative, and production remains **NO-GO**.
