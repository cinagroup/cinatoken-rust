# Container Runtime R2 Retention Evidence

## Status

The repository implements the credential-free, fail-closed verifier contract
for the container-runtime S3 immutable-retention subgate. It does not yet
contain a real staging R2 evidence bundle or authorize a remote mutation.

Current decision:

- S3 cryptographic evidence: accepted for the frozen subject.
- R2 retention contract: implemented and locally tested.
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

The evidence contract requires four distinct credential identities:

| Role | Cloudflare permission shape | Required capability evidence | Revocation |
| --- | --- | --- | --- |
| Publisher | R2 Object Read & Write, scoped to the evidence bucket | Object read/write; no lock API | Provider-confirmed after overwrite/delete probes and before final readback |
| Lock operator | R2 Admin Read & Write | Object and lock read/write, as the platform actually grants | Provider-confirmed after lock setup and before the first upload |
| Object verifier | R2 Object Read only, scoped to the evidence bucket | Object read/list only | Read-only during the decision |
| Lock verifier | R2 Admin Read only | Object read/list and lock read; no writes | Read-only during the decision |

Every credential is represented only by a SHA-256 identifier, permission
facts, expiry, and redacted provider revocation receipt. Secret values, access
key IDs, Authorization headers, request/response bodies, cookies, private
keys, and non-R2 account permissions are prohibited from the bundle.

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
  object-readback.json
  enforcement-probes.json
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
cinatoken-container-runtime-worm-retention-anchor-v1
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
3. Issue the four distinct short-lived credentials with the permission shapes
   above. Keep all values in approved secret channels only.
4. Use the lock operator to set an exact-prefix Age, Date, or Indefinite rule
   through `PUT /accounts/{account}/r2/buckets/{bucket}/lock`.
5. Read the rule back, record the canonical response facts, and revoke the
   lock operator before uploading any object.
6. Upload the six exact objects with create-only semantics. Reject a
   preexisting key or unresolved multipart upload.
7. Use the object verifier to list all pages and download every object.
   Recompute every digest and byte count.
8. Use the publisher to attempt different-content overwrite and deletion of
   the retained provenance packet. Both requests must reach Cloudflare and
   receive non-transient 4xx rejection with provider request IDs.
9. Revoke the publisher after both probes. Use the object verifier to prove
   the original object remains byte-identical.
10. Use the lock verifier to read the complete lock configuration after the
    probes and writer revocations.
11. Build the four canonical evidence documents and manifest. Operations and
    security independently inspect and sign the subject digest.
12. Run the offline verifier from a clean host with the trust policy supplied
    separately. Preserve its JSON output as the S3 decision receipt.

For an Age rule, the earliest per-object retention deadline must still be at
least one year after the manifest decision time. For a Date rule, the date
must satisfy the same minimum. Indefinite is accepted. The selected rule must
be enabled and match the exact content-addressed prefix.

## Provider Enforcement Requirements

Overwrite and delete probes are evidence only when:

- the transport completed;
- the provider, rather than a client guard, rejected the operation;
- the result is a non-transient 4xx other than 404;
- a provider request ID, error code, response-body SHA-256, and time exist;
- overwrite attempted different non-empty content;
- delete targeted the exact original object;
- a later readback matches the original SHA-256, bytes, and ETag;
- the final lock readback occurs after the probes and final object readback.

Timeouts, 408, 425, 429, 404, local policy denial, missing request IDs,
successful writes/deletes, stale lock reads, and object drift are ambiguous
and fail closed.

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
```

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

## Next Execution Unit

The next implementation is a credentialed staging collector that emits this
schema without placing secrets in argv, files, logs, workflow artifacts, or
Git history. It must use a dedicated bucket, ephemeral credentials, bounded
network operations, complete pagination, create-only writes, provider
readbacks, and explicit token-revocation receipts. Collector self-tests are
not real evidence. Registry R3 remains blocked until an independently reviewed
real bundle passes this verifier.

Primary references:

- [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
- [Cloudflare R2 authentication and permissions](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- [Cloudflare TypeScript bucket-lock API at audited commit](https://github.com/cloudflare/cloudflare-typescript/blob/3583affb5cea551858ed4c4b6c0fc326a306d3bd/src/resources/r2/buckets/locks.ts)
