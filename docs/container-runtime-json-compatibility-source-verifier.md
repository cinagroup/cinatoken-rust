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

The account-wide collector v2 protocol and local implementation are being
developed, but no production credential ceremony, remote collection,
create-once raw-page archive, or independent archive readback has completed.
The isolated signer ceremony, external archive integration, create-once R2
uploader, and remote verifier readback also remain open. The diagram is the
required production topology, not a deployment claim.

## Transition-Bound Request

The deployment-transition protocol now uses source-authentication request and
proof v2. The canonical request binds:

- operation ID and complete operation digest;
- owner-authorized transition digest;
- exact campaign Plan v5 and deployment state-plan v2 digests;
- transition ID, ordinal, from/to states, and transition digest;
- account identity;
- transition and optional phase source-manifest digests;
- all-18-artifact and account-wide binding-inventory digests;
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
container-runtime/json-compatibility/source-authentication/v2/sha256/
  bundles/<first-two-hex>/<source-envelope-sha256>.json
```

The canonical UTF-8 JSON body ends in exactly one LF and contains:

1. current Plan v5 and state-plan v2;
2. a transition source manifest binding source revision/tree, Worker bundle,
   Container image, D1 migration, and contract sets;
3. a phase source manifest v3 only for campaign-closure profiles;
4. exact readback identities for all 18 dark/status/execution artifacts;
5. an account-wide service, route, and Service Binding edge inventory;
6. an external-WORM archive receipt;
7. an Ed25519 source-signature envelope; and
8. the canonical bundle digest.

The account inventory explicitly binds a complete endpoint-schedule and
pagination assertion, collector identity, two authentication identities,
two page-chain heads, independent readback evidence, API request/page counts,
complete service/zone/route/binding set digests, and the seven campaign
service names. The in-progress v2 collector must obtain and retain the real
values before the bundle is admissible; fixture or synthetic values are not
remote evidence.

The archive receipt requires `external-worm`, compliance mode, at least 365
days of retention, object version and ETag digests, retention evidence, and an
independent readback timestamp. Cloudflare R2 is only the verifier's bounded
retrieval cache. R2 is not represented as WORM, and an R2 object cannot satisfy
the external immutable-retention requirement by itself.

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
least-privilege permission set. The profile signer validates that receipt and
pins its receipt and permission-set digests. The online verify result must
hash to the same credential ID before any inventory request is admissible.

The intended permission set contains only the account/zone scopes needed for
`Workers Scripts Read`, `Workers Routes Read`, and `Zone Read`. It contains no
Workers write, route write, D1 write, or token-management permission,
including `Account API Tokens Read`. In particular, the collector must not
call a token-detail endpoint merely to assert its own privileges. Explicit
receipt objects,
signature/issuer validation, and the verify-to-receipt credential-ID check are
still P0 integration work; a bare permission digest supplied by a test fixture
does not close this gate.

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
| `account-zones` | `GET /zones?account.id=...&page=N&per_page=50&order=id&direction=asc&match=all` | exactly pages 1 through `P`, with stable totals and no gaps |
| `zone-worker-routes` | `GET /zones/{zone_id}/workers/routes` | exactly `Z`, one for every returned zone |

The exact request/page count for one traversal is therefore
`3 + 2*S + V + P + Z`; stable collection and independent readback contribute
twice that count. Each receipt binds its resource family and exact resource
identity, request-path digest, response-body digest and byte length, result
count, page coordinates, request-ID digest, observation time, and predecessor.
Sequences must be contiguous, request IDs unique, and the expected service,
active-version, zone-page, and zone-route identity multisets exact. Merely
observing every resource-family name once is insufficient.

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

Both traversals' raw pages, page receipts, collector/profile identities, and
terminal artifacts must then be placed in an external compliance-mode WORM
archive with at least 365 days retention. A separately authorized reader must
verify object version, retention mode/deadline, ETag and SHA-256, byte length,
and canonical manifest closure before source signing. The collector library's
`rawPageSink` callback is only an integration boundary. Until a reviewed
create-once sink, external WORM implementation, and independent readback
receipt exist, it is not immutable-storage evidence.

## Verification Pipeline

The Worker fails closed in this order:

1. require exact staging service/profile/key-prefix/issuer/audience and both
   default-off gates;
2. validate Version Metadata, R2 binding, current key, and optional bounded
   previous-key window;
3. recompute the verifier-policy and Version Metadata identity digests and
   reject a non-approved policy or code version before any R2 read;
4. accept at most 16 KiB of strict canonical request input;
5. derive one bundle key from the approved envelope digest and perform only
   R2 `head` and `get`;
6. require stable version/ETag/size, a body of at most 12 MiB, fatal UTF-8,
   bounded JSON depth/node/string sizes, canonical JSON plus one LF, exact
   content type, and exact custom metadata;
7. validate every nested plan, manifest, inventory, archive, timing, account,
   transition, and digest relationship;
8. select only the configured current key or an unexpired previous key;
9. check the SPKI-digest revocation marker before Ed25519 verification;
10. verify the pinned SPKI and domain-separated Ed25519 signature, then check
    revocation again; and
11. return a canonical authenticated, rejected, or ambiguous proof bound to
    the exact request and verifier identity.

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
bun run check:container-runtime:json-compatibility-source-verifier
bun run check:container-runtime:json-compatibility-deployment-transition-worker
```

Current focused evidence on 2026-08-05 is:

| Gate | Result |
| --- | --- |
| Transition protocol | 13 tests, 150 expectations; includes exact v2 request/proof replay, cross-operation/plan binding, and proof-time rejection |
| Generated types and TypeScript | pass |
| Source verifier dry-runs | local and staging pass; 301.25 KiB upload / 49.37 KiB gzip; both gates false |
| Source verifier Node tests | 3 files, 13 tests |
| Source verifier Workerd/R2 tests | 1 file, 3 tests; canonical read-only verification, missing object, and revocation |
| Transition Worker Node tests | 2 files, 8 tests |
| Transition Worker Workerd integration | 1 file, 2 tests; real secondary verifier Worker plus shared R2 and real D1 |
| Complete repository | `bun run check` passed with exit code 0 in 1,452.7 seconds |

The integrated Workerd test seeds a canonical R2 bundle, routes the transition
through the actual verifier named entrypoint, proves exactly one verifier call,
executes four deployment-leaf mutations and 16 stable reads, and proves exact
replay/status add no verifier or leaf calls. The deployment leaf remains a
mock; the source verifier does not.

A dedicated least-privilege GitHub workflow runs the three focused gates on
relevant changes using pinned checkout and Bun actions, frozen dependencies,
`contents: read`, no deployment credential, and no remote mutation.

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
5. implement an isolated offline signer ceremony with current/previous key
   rotation, revocation publication, two-person approval, and no key in argv,
   environment, tracked files, logs, Worker secrets, or R2;
6. implement a create-once R2 uploader that refuses an existing key, publishes
   canonical body/metadata, reads back exact version/ETag/body, and retains the
   result independently;
7. create the remote R2 bucket and deploy this Worker dark with both gates
   false, then independently read back its exact version, named export,
   configuration, trust policy, R2 binding, route absence, and every caller;
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

The source verifier closes one local P0 implementation gap. Collector v2 is
still local work in progress and has not produced admissible remote evidence.
The signed credential receipts, create-once raw-page/WORM sink, independent
archive reader, signer, R2 uploader, remote bucket/verifier readback,
deployment leaf, D1 create-once provisioner and immutable remote schema,
inflight resolver, fault campaign, and wider provider/billing/settlement/
storage/SLO/cost/security/privacy/rollback/cutover evidence remain open. The
existing local append-only D1 journal does not prove remote D1 creation or
schema application. No Cloudflare or Go/VPS state changed. Go/VPS remains
authoritative and production remains **NO-GO**.
