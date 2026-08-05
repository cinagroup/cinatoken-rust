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
independent Cloudflare inventory collector
  -> external compliance-mode WORM archive and independent readback
  -> isolated offline Ed25519 source signer
  -> create-once canonical R2 retrieval bundle
  -> private Source Verifier Worker (R2 head/get only)
  -> source-authentication proof v2
  -> private Deployment Transition Worker
```

The collector, isolated signer ceremony, external archive integration,
create-once uploader, and remote readback are not implemented by this
increment. The diagram is the required production topology, not a deployment
claim.

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

The account inventory explicitly binds a complete pagination assertion,
collector identity, authentication identity, page-chain head, independent
readback evidence, API request/page counts, complete service/route/binding
set digests, and the seven campaign service names. This is a protocol
requirement. A future collector must obtain and retain the real values.

The archive receipt requires `external-worm`, compliance mode, at least 365
days of retention, object version and ETag digests, retention evidence, and an
independent readback timestamp. Cloudflare R2 is only the verifier's bounded
retrieval cache. R2 is not represented as WORM, and an R2 object cannot satisfy
the external immutable-retention requirement by itself.

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

1. implement and independently review the account-wide paginated inventory
   collector with least-privilege read credentials and retained raw pages;
2. provision the external compliance-mode WORM archive, independently read it
   back, and produce the exact retention receipt;
3. implement an isolated offline signer ceremony with current/previous key
   rotation, revocation publication, two-person approval, and no key in argv,
   environment, tracked files, logs, Worker secrets, or R2;
4. implement a create-once uploader that refuses an existing key, publishes
   canonical body/metadata, reads back exact version/ETag/body, and retains the
   result independently;
5. create the remote R2 bucket and deploy this Worker dark with gates false;
6. independently read back exact Worker version, named export, configuration,
   trust policy, R2 binding, route absence, and all callers that can reach it;
7. deploy the all-seven-service deployment readback/mutation leaf and
   Transition Worker, also dark, after their separate reviews;
8. upload and read back all 18 frozen artifacts, generate release evidence,
   and execute only the first two transitions under separate approvals;
9. run the four-phase campaign, generate closure source-manifest v3, then use
   separately approved closure evidence for the final two transitions; and
10. retain all raw evidence, signatures, revocation state, receipts, and remote
    readbacks for independent offline replay.

The source verifier closes one local P0 implementation gap. The collector,
signer, uploader, external archive, remote bucket/readback, deployment leaf,
remote D1, inflight resolver, fault campaign, and wider provider/billing/
settlement/storage/SLO/cost/security/privacy/rollback/cutover evidence remain
open. No Cloudflare or Go/VPS state changed. Go/VPS remains authoritative and
production remains **NO-GO**.
