# Private JSON Compatibility Source Verifier

## Decision And Boundary

`services/container-runtime-json-compatibility-source-verifier` is the private,
read-only trust boundary used by the JSON compatibility deployment-transition
Worker. It answers one named Service Binding RPC:
`JsonCompatibilitySourceVerifierEntrypoint.authenticateTransitionSource`.
The default entrypoint is inert. Both tracked configurations set
`workers_dev=false`, `preview_urls=false`, declare no route, contain no
Cloudflare credential, bind only local R2, and leave the master and R2-read
gates false.

The Worker verifies retained evidence. It does not collect Cloudflare state,
sign source evidence, upload or delete R2 objects, deploy Workers, mutate
bindings, or grant campaign/production approval. Rust remains in the Linux
Container data and compute plane; this TypeScript Worker is a narrow
Cloudflare control-plane verifier.

```text
offline-approved collection profile and two credential-creation receipts
  -> collection credential -> account-wide Cloudflare inventory pass
  -> independent credential -> complete independent readback pass
  -> create-once raw-page sink and external compliance-mode WORM archive
  -> independent WORM readback
  -> isolated offline Ed25519 source signer
  -> create-once canonical R2 retrieval bundle
  -> private Source Verifier Worker (R2 head/get only)
  -> source-authentication proof v2
  -> private Deployment Transition Worker
```

The account-wide collector v2 protocol, bounded Cloudflare transport,
three-mode CLI, terminally closed local capture directory, provider-neutral C2
contract, Amazon S3 Object Lock data plane, structured evidence, and exact
legacy inventory projection are implemented and locally tested. No production
credential ceremony, remote collection, external-WORM publication, or real
independent archive readback has completed. The isolated signer ceremony,
create-once R2 uploader, and remote verifier readback also remain open. The
diagram is the required production topology, not a deployment claim.

## Transition-Bound Request

The deployment-transition protocol now uses source-authentication request and
proof v2. The canonical request binds:

- operation ID and complete operation digest;
- owner-authorized transition digest;
- exact campaign Plan v5 and deployment state-plan v2 digests;
- transition ID, ordinal, from/to states, and transition digest;
- account identity;
- transition and optional phase source-manifest digests;
- all-18-artifact, structured account-wide binding-evidence, and exact legacy
  binding-inventory projection digests;
- external immutable-archive receipt and source-signature-envelope digests;
- the approved verifier-policy and exact Version Metadata identity digests; and
- the canonical request digest itself.

The transition approval binds the final source-signature-envelope digest. The
source signature binds the operation, plans, transition, evidence roots,
approved verifier policy, and exact verifier deployment identity. Execution
and terminal-receipt replay reconstruct
the exact same v2 request. A proof for another operation, plan, transition,
policy, or source bundle cannot be substituted.

Two source profiles are required because the campaign phase source manifest
does not exist before the campaign has run:

| Transition | Source profile | Phase source manifest |
| --- | --- | --- |
| `dark -> statusOnly` | `release-v1` | must be absent |
| `statusOnly -> execution` | `release-v1` | must be absent |
| `execution -> statusOnly` | `campaign-closure-v1` | required, schema v3 |
| `statusOnly -> dark` | `campaign-closure-v1` | required, schema v3 |

This ordering prevents the first two transitions from depending on evidence
that can only be produced after the four-phase campaign.

## Canonical Source Bundle

The fixed, digest-derived R2 key is:

```text
container-runtime/json-compatibility/source-authentication/v3/sha256/
  bundles/<first-two-hex>/<source-envelope-sha256>.json
```

The canonical UTF-8 JSON body ends in exactly one LF and contains:

1. current Plan v5 and state-plan v2;
2. a transition source manifest binding source revision/tree, Worker bundle,
   Container image, D1 migration, and contract sets;
3. a phase source manifest v3 only for campaign-closure profiles;
4. exact readback identities for all 18 dark/status/execution artifacts;
5. structured account-wide service, zone, route, cross-script edge, page-chain,
   authentication, and independent-readback evidence;
6. the exact legacy account-binding inventory projected from item 5;
7. the complete C2 archive policy, exact manifest, writer-signed observations,
   and independently signed exact-version readback closure;
8. a v3 immutable-archive receipt derived only from item 7;
9. an Ed25519 source-signature envelope; and
10. the canonical bundle digest.

The account inventory explicitly binds a complete endpoint-schedule and
pagination assertion, collector identity, two authentication identities,
two page-chain heads, independent readback evidence, API request/page counts,
complete service/zone/route/binding set digests, and the seven campaign
service names. A production v2 collector run must obtain and retain the real
values before the bundle is admissible; fixture or synthetic values are not
remote evidence.

The archive receipt v3 is not caller-authored storage metadata. It is derived
from the complete C2 evidence and binds its externally pinned policy, manifest,
object/identity sets, writer/readback envelopes, compliance deadline,
chronology, and exact structured account evidence. The Source Verifier policy
hash also binds the external C2 policy digest. Signature subject/envelope v2
then transitively bind the v3 receipt under the v2 C4 domain separator.
Cloudflare R2 is only the verifier's bounded retrieval cache. R2 Bucket Lock is
not accepted as S3 Object Lock compliance evidence and cannot satisfy C2 by
itself.

## Account-Wide Collector V2 Contract

### Credential provenance and independence

One token cannot both create the primary observation and attest its readback.
The production profile requires two independently issued Cloudflare API
tokens with different credential IDs and separate custody:

| Role | Online use | Required provenance |
| --- | --- | --- |
| `collection` | exactly one complete account traversal | signed offline credential-creation receipt and collection permission-set digest |
| `independent-readback` | a second complete traversal 5-900 seconds later | a different signed receipt, credential ID, custodian, and readback permission-set digest |

Each token is injected into only its own process through a secret-capable
runtime channel. It must never appear in argv, tracked files, logs, receipts,
raw-page keys, or canonical source bundles. The two executions must not share
a token, token ID, writable cache, mutable output prefix, or Cloudflare write
permission.

The online collector calls only
`GET /client/v4/accounts/{account_id}/tokens/verify`. Token verification proves
the presented token ID and active status; it does not prove the permission
set. The exact read-only permissions and resource scopes therefore come from
an offline credential-creation receipt. The receipt must canonically bind the
account digest, credential-ID digest, role, creation/expiry facts, and the
least-privilege permission set. The offline credential signer and profile
assembler validate that receipt; the canonical profile pins its receipt and
permission-set digests. The online verify result must hash to the same
credential ID before any inventory request is admissible.

The intended permission set contains only the account/zone scopes needed for
`Workers Scripts Read`, `Workers Routes Read`, and `Zone Read`. It contains no
Workers write, route write, D1 write, or token-management permission,
including `Account API Tokens Read`. In particular, the collector must not
call a token-detail endpoint merely to assert its own privileges. Explicit
receipt objects, signature/issuer validation, and the verify-to-receipt
credential-ID check are now implemented locally. A bare permission digest is
no longer accepted by the collection-profile contract.

The credential provenance v1 contract retains an offline-approved current/
previous Ed25519 SPKI policy, one signed receipt per role, and a current-key
signed complete revocation snapshot. Each receipt binds the exact account and
credential-ID digests, the three read-only permission group IDs/names, account
and all-account-zone scope, one-hour maximum lifetime, issuing principal,
distinct custodian, two distinct approvers, approval-policy digest, and
explicit absence of write/token-management permission or secret retention.
The profile binds the complete provenance object, its approval time, both
receipt/permission/custodian digests, trust-policy digest, and revocation-state
digest. At approval and collection time, each credential must retain at least
ten minutes of life; a revocation snapshot is valid for at most 15 minutes.
The previous trust key is accepted for at most one hour after the policy's
effective time. Trust-policy and revocation-state digests plus the minimum
accepted revocation sequence are supplied independently to the signer,
assembler, and online collector; provenance cannot introduce its own trust
root or roll back to an older still-current snapshot.

`bun run sign:container-runtime:json-compatibility-account-binding-credential`
accepts only a canonical receipt or revocation subject, externally pinned
trust-policy digest, one canonical PKCS8 DER/PEM Ed25519 key on non-TTY stdin,
and absent output path. It rejects trailing or concatenated key material,
derives and matches the public SPKI, signs under a dedicated domain,
self-verifies, refuses ambient Wrangler credential variables, syncs one
create-only envelope, clears the caller-visible input key bytes, and performs
no network request. `bun run
assemble:container-runtime:json-compatibility-account-binding-profile`
accepts the two envelopes, current revocation, plans, collector identity, and
allowed edges plus external trust/revocation digests and minimum sequence. It
refuses Wrangler token/API-key/email credential variables, verifies every
trust slot, signature, time/custody/revocation invariant, and creates one
canonical profile. The online collector repeats those anchored checks before
its first request, then permits only token verify; a returned token ID mismatch
stops before the Workers scripts request. Authentication identity binds the
verify page receipt and response-body digests, and retained artifact validation
replays credential/revocation validity at `verifiedAt`.

These tools establish a locally testable protocol, not a production token
ceremony. No real token creation receipt, managed-key custody proof, approver
attestation, rotation/revocation drill, or remote verify result has been
captured.

The Source Verifier performs strict structural/digest validation of the
embedded provenance but does not accept its embedded Ed25519 key as an
independent trust root. C1 signature verification happens in the externally
anchored assembler and collector; admissible publication still requires the
C4 outer source-bundle signature pinned by the verifier Worker configuration.

Local create-only files are fail-closed ceremony artifacts, not WORM proof.
Their parent directory must be pre-provisioned and trusted; an uncertain
write/sync/close consumes that artifact path and requires a new identity rather
than overwrite or retry. Input-buffer zeroing is defense in depth, so the
signer must still run as a short-lived isolated process backed by managed-key
custody.

The command boundary is
`bun run collect:container-runtime:json-compatibility-account-bindings`.
Online modes
accept canonical Plan, state-plan, profile, collector identity, account ID, a
external trust/revocation digests, minimum revocation sequence, new raw-page
directory, and a new artifact path. `collection` reads only
`CLOUDFLARE_ACCOUNT_BINDING_COLLECTION_TOKEN`; `independent-readback` reads
only `CLOUDFLARE_ACCOUNT_BINDING_READBACK_TOKEN`; each refuses the other token
and all generic Wrangler auth variables. `finalize` refuses all credential environments
and combines the two canonical artifacts offline into one create-once evidence
plus inventory package. `--self-test` and each mode's `--dry-run` perform zero
credential reads, network requests, or file writes.

### Exact endpoint schedule

Let `S` be the number of all Workers services returned for the account, `V`
the total number of active version IDs across those services, `P` the number
of numbered account-zone pages, and `Z` the number of zones. Each credential
must execute exactly this schedule, in order. Paths in the table are relative
to `/client/v4`:

| Resource family | Exact request | Cardinality and rule |
| --- | --- | --- |
| `credential-verification` | `GET /accounts/{account_id}/tokens/verify` | exactly 1; account identity |
| `workers-scripts` | `GET /accounts/{account_id}/workers/scripts` | exactly 1; no pagination metadata accepted |
| `worker-deployments` | `GET /accounts/{account_id}/workers/scripts/{service}/deployments` | exactly `S`, one for every listed service |
| `worker-version` | `GET /accounts/{account_id}/workers/scripts/{service}/versions/{version_id}` | exactly `V`, one for every active version; bindings come from `resources.bindings` |
| `worker-subdomain` | `GET /accounts/{account_id}/workers/scripts/{service}/subdomain` | exactly `S`; captures workers.dev and preview status |
| `account-worker-domains` | `GET /accounts/{account_id}/workers/domains` | exactly 1; absent pagination metadata or exact page 1 of 1 only |
| `account-zones` | `GET /zones?account.id=...&page=N&per_page=50&order=name&direction=asc&match=all` | exactly pages 1 through `P`, with stable totals and no gaps |
| `zone-worker-routes` | `GET /zones/{zone_id}/workers/routes` | exactly `Z`, one for every returned zone |

The exact request/page count for one traversal is therefore
`3 + 2*S + V + P + Z`; stable collection and independent readback contribute
twice that count. Each receipt binds its resource family and exact resource
identity, request-path digest, response-body digest and byte length, result
count, page coordinates, request-ID digest, observation time, and predecessor.
Sequences must be contiguous, request IDs unique, and the expected service,
active-version, zone-page, and zone-route identity multisets exact. Merely
observing every resource-family name once is insufficient. The validator also
requires the eight resource-family stages to be monotonic in the table order.

The custom-domain endpoint is treated as a single-page API. If it returns
`result_info`, only `page=1`, `total_pages=1`, and exact count/total-count
agreement are accepted. `total_pages > 1`, inconsistent metadata, or any need
to invent an undocumented page query fails closed. Zone enumeration is the
only numbered pagination loop in this contract.

### Route and cross-script closure

The snapshot covers the whole account, not only the seven campaign services.
It combines custom domains, every zone route, workers.dev state, and preview
URL state. The private-campaign assertion then requires zero public routes for
campaign services and compares every cross-script edge whose caller **or**
target is a campaign service against the exact approved edge set. An
unapproved outside caller into the campaign is as fatal as an unapproved
campaign caller out.

Active-version `resources.bindings` are normalized only for reviewed
cross-script capabilities: Service Bindings, external Durable Object
namespaces, dispatch-namespace outbound Workers, and Workflows targeting
another script. A binding with `type=inherit` fails closed because the
effective target is not proven by the active-version response. An unknown
binding type also fails closed unless it is present in the reviewed explicit
non-cross-script allowlist. New Cloudflare binding types require a contract
update, fixtures, negative tests, and review before collection can proceed.

### Raw-page create-once and WORM evidence

Normalization is not a substitute for source evidence. Before a page receipt
can advance the predecessor chain, the exact response bytes must be durably
accepted by a create-once sink under a deterministic key bound to profile,
mode, sequence, request-path digest, and response digest. Existing keys,
overwrite capability, partial writes, sink timeout, uncertain completion, or
digest/readback mismatch terminate that traversal. A retry starts a new
operation and output prefix; it never overwrites or silently resumes the
failed evidence chain.

The CLI now creates a previously absent capture directory, syncs a canonical
manifest binding mode/account/profile/collector identity, names each body and
receipt pair by the full page-receipt digest, checks exact body length and
SHA-256, uses create-once file opens, and syncs each file before returning to
the collector. After the terminal artifact is written, it verifies the exact
page-receipt sequence and raw directory contents, writes one create-once
`capture-terminal.json`, reads it back, and reports success only after both the
artifact and terminal closure exist. This is a local overwrite-resistant
capture boundary, not WORM.

Both traversals' raw pages, page receipts, collector/profile identities, and
terminal artifacts must then be placed in an external compliance-mode WORM
archive with at least 365 days retention. The local C2 contract now requires
one terminal per pass, an exact object set capped at 512 descriptors,
separate writer/reader principals, credentials and Ed25519 keys, and a
five-to-900-second exact-version readback. The cap keeps every valid C2 bundle
within the Worker's 12 MiB/200,000-node verifier envelope. Its first data-plane
adapter and create-once CLI issue one create-only Amazon S3 request with
COMPLIANCE retention and separately check versioning, Object Lock, bytes,
metadata and `GetObjectRetention`. A successful adapter observation explicitly
does not authorize C2 by itself. The writer and reader subjects sign the exact
canonical raw provider-observation-set digests, and a credential-free closure
maps every retained raw observation to its C2 object observation. Neither the
raw observations nor that closure authorize C2 without both valid C2
signatures. Until a real
external bucket and independent principals produce that closure, the evidence
is not production immutable-storage proof.

## Verification Pipeline

The Worker fails closed in this order:

1. require exact staging service/profile/v3 key-prefix/issuer/audience and both
   default-off gates;
2. validate Version Metadata, R2 binding, current key, optional bounded
   previous-key window, and a non-placeholder external C2 policy digest;
3. recompute the verifier policy, including the C2 policy anchor, and Version
   Metadata identity digests; reject a non-approved policy or code version
   before any R2 read;
4. accept at most 16 KiB of strict canonical request input;
5. derive one bundle key from the approved envelope digest and perform only
   R2 `head` and `get`;
6. require stable version/ETag/size, a body of at most 12 MiB, fatal UTF-8,
   bounded JSON depth/node/string sizes, canonical JSON plus one LF, exact
   content type, and exact custom metadata;
7. validate every nested plan, manifest, inventory, C2 evidence, derived v3
   archive receipt, timing, account, transition, and digest relationship;
8. select only the configured current C4 key or an unexpired previous key;
9. check the C4 SPKI-digest revocation marker, verify its domain-separated
   Ed25519 signature, then check revocation again;
10. verify the writer and independent-reader C2 signatures against the pinned
    policy, rejecting reuse of any C1 credential-authority or C4 signer SPKI;
11. replay the S3 observation closure, binding target, credential, version,
    ETag, checksum, bytes, metadata, retention, chronology and all provider
    request IDs to the signed C2 observation-set digests; and
12. return a canonical authenticated, rejected, or ambiguous proof bound to
    the exact request, C2 closure and verifier identity.

Deterministic absence, drift, malformed evidence, policy mismatch, untrusted
key, invalid signature, and revocation are `rejected`. R2 read uncertainty,
head/get drift, unreadable body, revocation-state uncertainty, or unavailable
crypto runtime are `ambiguous`. Neither classification authorizes an automatic
deployment retry.

Source signatures have a maximum seven-day lifetime, require at least 15
minutes remaining at verification, and bind evidence observed no more than one
hour before signing. The previous trust key has an explicit `acceptUntil` and
cannot overlap the current key ID or SPKI digest. The source request also binds
the complete current/previous verifier policy and exact Worker version,
preventing an operator from silently changing trust or code while reusing an
approval.

## Local Acceptance

Run:

```text
bun run check:container-runtime:json-compatibility-deployment-transition
bun run check:container-runtime:json-compatibility-account-binding-collector
bun run check:container-runtime:json-compatibility-external-worm
bun run check:container-runtime:json-compatibility-source-verifier
bun run check:container-runtime:json-compatibility-deployment-transition-worker
```

Current focused evidence on 2026-08-06 is:

| Gate | Result |
| --- | --- |
| Account-binding credentials/evidence/collector/CLI | 42 tests, 219 expectations; strict declaration check; terminal raw-capture closure; process-level DER/PEM stdin/tail/size/ambient-credential probes; anchored signer/profile descriptions; four credential-free collector self-test/dry-run plans |
| External WORM contract, S3 data plane, CLI and closure | 29 tests, 354 expectations; strict declarations; credential-free describe/two-mode dry-runs; no provider call; exact C2 policy/manifest/dual-signature closure, raw observation-set binding and S3 COMPLIANCE/readback fault classification |
| Transition protocol | 13 tests, 150 expectations; includes exact v2 request/proof replay, cross-operation/plan binding, and proof-time rejection |
| Generated types and TypeScript | pass |
| Source verifier dry-runs | local and staging pass; 565.43 KiB upload / 91.53 KiB gzip; both gates false |
| C4 signer/packet protocol | 5 tests, 26 expectations; acyclic intent projection, stdin-only Ed25519, external policy/identity anchors, digest-cycle exclusion and create-only assembly |
| Source Publisher dry-runs | local and staging pass; 462.65 KiB upload / 74.49 KiB gzip; both gates false |
| Source Publisher Node/Workerd tests | 7 Node and 2 real Workerd/R2 tests; one conditional put, occupied/ambiguous no-retry, exact body/metadata and default-off gates |
| Source verifier Node tests | 3 files, 20 tests; includes pre-R2 zero-anchor rejection, pinned C2 policy, forged writer/readback, terminal/S3 substitution, C2/C4 signer reuse and packet/write-receipt readback binding |
| Source verifier Workerd/R2 tests | 1 file, 3 tests; canonical read-only verification, independent publication receipt, missing object, and revocation |
| Transition Worker Node tests | 2 files, 8 tests |
| Transition Worker Workerd integration | 1 file, 2 tests; real secondary verifier Worker plus shared R2 and real D1 |
| Complete repository | `bun run check` passed with exit code 0 in 1,348.6 seconds on 2026-08-06 |

The integrated Workerd test seeds a canonical R2 bundle, routes the transition
through the actual verifier named entrypoint, proves exactly one verifier call,
executes four deployment-leaf mutations and 16 stable reads, and proves exact
replay/status add no verifier or leaf calls. The deployment leaf remains a
mock; the source verifier does not.

Dedicated least-privilege GitHub workflows run the collector and three verifier/
transition focused gates on relevant changes using pinned checkout and Bun
actions, frozen dependencies, `contents: read`, no deployment credential, and
no remote mutation.

These results are local protocol, Wrangler dry-run, R2 emulator, D1 emulator,
Workerd, frontend, supply-chain, Rust workspace, and wasm32 evidence. They are
not proof of a real Cloudflare account, remote
R2 object, external WORM archive, managed signing key, or deployed Service
Binding.

## Production Sequence And Blockers

Before any isolated staging transition:

1. freeze and independently review collector v2, its signed profile, exact
   endpoint schedule, cross-script binding classifier, bounds, poisoned-fetch
   self-test, and create-once raw-page sink interface;
2. issue two independently held read-only tokens, produce signed offline
   credential-creation receipts, and prove verify-result credential IDs and
   permission-set digests match the corresponding profile slots;
3. provision the external compliance-mode WORM archive, run the complete
   `collection` and `independent-readback` traversals in separate processes,
   and independently read back every raw page and terminal artifact;
4. require stable service, active-version, zone, route, and cross-script edge
   sets across both traversals, then generate the canonical account evidence;
5. create the remote R2 bucket and deploy this Worker dark with both gates
   false, then independently read back its exact version, named export,
   configuration, trust policy, R2 binding, route absence, and every caller;
6. derive the exact verifier identity from that real Version Metadata ID and
   frozen policy, then run the isolated offline signer ceremony with
   current/previous key rotation, revocation publication, two-person approval,
   and no key in argv, environment, tracked files, logs, Worker secrets, or R2;
7. deploy/read back the private Publisher dark, assemble the final packet,
   execute one create-once R2 write, and produce an independent Verifier
   body/version/ETag/metadata receipt; response ambiguity permits readback-only
   recovery and never a second put;
8. implement and audit the all-seven-service deployment leaf with physically
   separate read and mutation capabilities, exact account/service/version/
   entrypoint allowlists, one mutation send, no automatic retry, stable target
   readback, and an immutable operation receipt;
9. provision staging D1 through a separately approved create-once operation:
   prove the intended name is absent, send create at most once, resolve an
   ambiguous response only by read-only inventory, freeze the returned
   database ID and migration-set digest, apply the immutable schema once, and
   independently read back the exact migration/table/index/trigger inventory;
10. deploy the Transition Worker dark only after its D1 binding, append-only
    journal schema, source-verifier binding, deployment-leaf binding, routes,
    gates, and Version Metadata are independently proven;
11. upload and read back all 18 frozen artifacts, regenerate account-wide
    inventory after bootstrap, and execute only the first two transitions
    under separate owner approvals;
12. pass response-loss, timeout, crash, concurrency, drift, stale-approval,
    archive-readback, custom-domain pagination, unknown-binding, and D1
    create-ambiguity fault campaigns without a second mutation send;
13. run the four-phase campaign, generate closure source-manifest v3, then use
    separately approved closure evidence for the final two transitions; and
14. retain all raw evidence, signatures, revocation state, receipts, remote
    readbacks, D1 creation/migration evidence, and deployment receipts for
    independent offline replay.

The source verifier, source publisher, isolated stdin-only C4 signer,
credential-free packet assembler, collector v2, credential-provenance v1,
terminal raw capture, C2 contract and Amazon S3 data plane close local
implementation gaps but have not produced admissible remote evidence. Real signed
credential-issuance receipts and managed-key ceremony evidence, external WORM
publication/readback attestations, managed C4 signing ceremony, remote
bucket/Publisher/Verifier readback,
deployment leaf, D1 create-once provisioner and immutable remote schema,
inflight resolver, fault campaign, and wider provider/billing/settlement/
storage/SLO/cost/security/privacy/rollback/cutover evidence remain open. The
existing local append-only D1 journal does not prove remote D1 creation or
schema application. No Cloudflare or Go/VPS state changed. Go/VPS remains
authoritative and production remains **NO-GO**.
