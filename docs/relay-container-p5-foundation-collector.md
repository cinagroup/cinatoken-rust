# Relay Container P5 Foundation Collector

## Purpose

`tools/collect_relay_container_p5_foundation.mjs` creates the bounded,
redacted foundation capture consumed by the P5 `candidate-freeze` and
`remote-inventory` evidence records. It does not deploy, roll back, wake a
Container, send provider traffic, write an evidence file, authorize a canary,
or authorize production traffic.

Every collector result has `decision=not-proven`, `p5Eligible=false`,
`customerTrafficEligible=false`, and `productionEligible=false`.
`foundationEvidenceReady=true` means only that the two foundation fact cores
are ready for independent evidence assembly and owner review. The other nine
P5 evidence kinds, the signed manifest, and all five independent approvals are
still mandatory.

Current local candidate baseline: D1 head 0070/count 70, 92 required tables,
1463 checked incremental columns, and 137 key indexes. Migration 0055 remains
the historical shard-activation campaign baseline, 0063 remains placement
authorization storage provenance, and 0068 remains admission-fence evidence
provenance; a new candidate must bind 0070. No live
Cloudflare readback, migration application,
deployment, Durable Object/Container wake, or traffic change is claimed.

## Local Commands

```powershell
bun run check:relay-container:p5-foundation
bun run check:relay-container:p5-shard-registry
bun run plan:relay-container:p5-foundation -- --request C:\secure-evidence\p5\foundation-request.json
bun run collect:relay-container:p5-shard-registry -- `
  --request C:\secure-evidence\p5\shard-registry-request.json `
  --dry-run
```

Live staging readback is deliberately separate from `bun run check`:

```powershell
bun run collect:relay-container:p5-foundation -- `
  --request C:\secure-evidence\p5\foundation-request.json `
  --source-bundle C:\secure-evidence\p5\foundation-sources.json `
  --confirm-staging-readback `
  --confirm-replacement-token `
  --confirm-observation-window
```

The app-owned shard source is collected independently before it is embedded in
foundation sources v3:

```powershell
bun run collect:relay-container:p5-shard-registry -- `
  --request C:\secure-evidence\p5\shard-registry-request.json `
  --confirm-staging-readback
```

Provision `CINATOKEN_P5_SHARD_REGISTRY_COOKIE` in the parent process through the
approved secret workflow. Do not place that cookie in an argument, tracked
file, evidence output, shell history, or ticket. The shard collector sends it
only to the validated HTTPS staging origin and emits no credential value.

Provision `CINATOKEN_P5_READBACK_TOKEN` in the parent process through the
approved secret workflow before the live command. Never put the value in an
argument, repository file, evidence file, shell history, or ticket. The
previously exposed credential is not acceptable; it must be revoked and a
rotated replacement credential must be used.

The collector reads only `CINATOKEN_P5_READBACK_TOKEN`. It injects that value
only as the in-memory `Authorization: Bearer ...` header of each fixed HTTPS
GET after validating the complete credential-free request plan. It never puts
the token in a URL, command argument, output object, file, or child process.

## Request Contract

The request is canonical JSON plus exactly one newline and uses:

```text
cinatoken-relay-container-p5-foundation-request-v1
```

It contains exactly:

- `schemaVersion=1`, `contract`, and `environment=staging`;
- `observationSeconds`, from 300 through 7200;
- the raw Cloudflare account ID, CONFIG_KV namespace ID, and Container
  application ID needed only for child readback;
- the complete strict P5 candidate object.

The request validator requires the staging Worker, Controller, provider-egress,
D1, and R2 identities. It hashes the CONFIG_KV ID and requires that digest to
match the candidate. Raw account, KV, and Container application IDs never
appear in the emitted capture.

The candidate remains pinned to:

- `cinagroup/cinatoken-rust` and its exact commit;
- Go source commit `73652508abc5cb09214dde02d51d69d1d1ccc703`;
- cinaVibeSDK source commit
  `918e97480ee44e357abe99bf33c27259d6ac7ebd`;
- Container image digest, runtime executable build SHA-256, and a separate
  runtime-to-image provenance SHA-256;
- migration `0060_relay_container_ring_transition_authority.sql`, count 60;
  and
- response/status/financial-terminal/terminal-ACK contracts 3/4/2/3.

Earlier 0054/54 through 0059/59 candidates are retained as history only; a new
foundation request using any of them must fail the current P5 candidate
validator.

Unknown fields, production identities, short observation windows, candidate
drift, unsafe integers, noncanonical JSON, symbolic links, multiply linked
files, invalid UTF-8, and credential-shaped values fail closed.

## Read-Only Cloudflare API Allowlist

Collector version 4 uses direct Cloudflare REST readback so terminal
pagination evidence is independent of Wrangler output formatting. The plan
contains exactly 13 credential-free requests under the fixed origin
`https://api.cloudflare.com/client/v4`, the exact staging account path, and a
closed path/query allowlist:

1. exact edge Worker version and deployment inventory;
2. exact Controller Worker version and deployment inventory;
3. exact provider-egress Worker version and deployment inventory;
4. exact D1 database and R2 bucket information;
5. all KV namespaces;
6. all Container applications plus exact application information, including
   the deployed `configuration.image` digest;
7. all Container instances; and
8. Container application deployment inventory.

Every operation is `GET`; redirects are errors, arbitrary hosts/paths/query
keys are rejected, and the account ID in each URL must equal the validated
request account. There is no shell or child process. Each request has a
60-second per-request deadline covering both headers and body plus a five-minute
whole-readback deadline, requires HTTP 200 and JSON,
decodes UTF-8 fatally, caps each streamed body at 4 MiB, and caps aggregate
readback at 16 MiB, 1,024 pages, and 100,000 items. Credential reflection is a
fatal collector error. Raw responses, cursors, private IDs, and credentials
are never emitted; output contains only structural pagination facts, counts,
byte counts, identity matches, and canonical SHA-256 digests.

KV uses strict page-number traversal. Every page must report matching
`page`, `per_page`, `count`, `total_count`, and `total_pages`; totals must stay
stable, records must be unique, and the final accumulated count must equal the
reported total. Container applications and instances use opaque page tokens;
tokens must be bounded, non-repeating, and eventually return explicit null.
Official single-response endpoints reject unexpected pagination metadata.
Neither a short page nor finding the expected object proves completion.
Worker deployment readback accepts only the first deployment documented as
actively serving traffic and requires exactly the candidate version at 100%.
Container deployment inventory must be nonempty; every current placement must
use the candidate image digest. Worker version, D1, R2, and Container-info
responses have endpoint-specific object/field contracts rather than recursive
value matching. The offline verifier also validates every one of the 13 summary
records and recomputes the aggregate readback digest.

## Observation And Stability

The collector records a complete before snapshot, starts the bounded observation
after that snapshot finishes, observes for 300 through 7200 seconds, ends the
observation before starting the same 13-request after snapshot, and then records
that complete after snapshot. Readback command time therefore cannot inflate an
otherwise valid observation beyond the P5 verifier's two-hour maximum. Both
snapshots must:

- complete without unsafe output;
- prove their bounded pagination;
- contain every exact candidate identity;
- have no transport or API-envelope diagnostic; and
- have the same canonical digest.

The two P5 evidence records must be captured no later than 15 minutes after the
foundation observation ends. The offline verifier rejects a longer sealing
lag even when the original window length was valid.

The collector code inventory is also hashed before and after the observation.
It includes the foundation and shard collectors, both readback libraries, the
P5 evidence contract, and the root package/lock files. Any tool artifact drift
blocks foundation readiness.

Container deployment inventory is stability evidence, not image-digest proof.
The exact candidate digest must match the Container application's
`configuration.image` field as either the digest itself or the digest suffix
of an image reference; the independent SBOM/provenance source must bind the
same digest.

## Required External Sources

Cloudflare control-plane inventory is not a complete shard ledger. In particular,
Container application and instance lists cannot prove every sleeping Durable
Object member. A live capture therefore remains `not-proven` unless a strict
canonical source bundle is supplied with contract:

```text
cinatoken-relay-container-p5-foundation-sources-v3
```

The bundle has `schemaVersion=3`; it is candidate-bound, account-bound,
captured inside the observation window, pagination-complete, and contains these
five independently identified source records:

| Source | Required proof |
| --- | --- |
| `actionGates` | every admission, execution, writer, retry, recovery, and wake gate is false |
| `sbom` | exact image digest, runtime build ID, image-provenance digest and SBOM digest, verified signature/provenance, zero unapproved critical/high findings |
| `shardRegistry` | stable sealed campaign plus activation and placement-event capture, exact Controller/runtime/ring candidate, derived N/N verified shards and placements |
| `r2Inventory` | complete writer/object inventory with zero unknown writers and zero unknown objects |
| `traffic` | zero customer traffic and verified staging isolation |

Each source carries `status`, `collectorId`, `collectorVersion`, and
`sourceArtifactSha256`. The local canonical source bundle is bounded to 8 MiB
so the v3 campaign/activation/placement evidence for 1024 shards fits without
making input unbounded. Per-response and aggregate Cloudflare API readback
bounds remain unchanged. For action gates,
SBOM, R2, and traffic, the digest must equal canonical JSON of the exact source
record with only `sourceArtifactSha256` removed. For `shardRegistry`, the
foundation validator rebuilds the embedded capture and requires the digest to
equal that canonical capture. These are integrity bindings; source provenance
and any external signature must still be retained for owner review.
`unknown` and `fail` are representable but always block foundation readiness.
Omitting the bundle yields explicit blockers for all five sources and sets
`binding.paginationComplete=false`.

## Shard Registry Source

`tools/collect_relay_container_p5_shard_registry.mjs` is the concrete
`shardRegistry` source collector. Its strict staging request binds Controller
version ID, runtime build ID, Container image digest, image provenance digest,
ring generation, and shard count. `observationSeconds` is an integer from 300
through 7200, and `shardCount` is bounded from 1 through the real 1024-shard
ceiling.

The origin is exactly `https://staging.cinatoken.com`; arbitrary
`workers.dev` or sibling origins are rejected. Live collection requires a root
session cookie from `CINATOKEN_P5_SHARD_REGISTRY_COOKIE`, never a CLI argument.
Redirects fail, each response has a 15-second deadline, and streamed response
bytes are cancelled above 1 MiB rather than buffered without a bound.

For both before and after snapshots it first calls root-authenticated,
`Cache-Control: no-store`
`GET /api/platform/container/shards/activation-campaigns`, then calls
`GET /api/platform/container/shards/activations` and
`GET /api/platform/container/shards/placements`. The campaign readback must be
`sealed_complete`, bind the exact candidate and foundation manifest, and carry
one validated consumption receipt per shard. The first activation response
freezes its activation high watermark. The first placement response separately
freezes the maximum database-assigned `placement_event_sequence`; it never uses
`activation_id` as placement insertion order. Every later request sends the
matching frozen watermark plus the previous page's keyset cursor. Pages contain
at most 64 records, sequences and cursors must increase strictly, the terminal
page must return `next_cursor=null`, and each flattened record count and last
sequence must equal its `total_records` and frozen high watermark. The
collector caps each evidence inventory at 4096 records and 65 pages.

The Worker reader and the offline collector independently recompute every
`activation_digest_sha256`, `consumption_digest_sha256`, canonical shard-name
hash, and placement-attestation digest using the same length-prefixed
domain-separated contracts as the Controller writer. Each receipt must match
exactly one 0054 activation and exactly one 0062 event-backed 0061 placement.
The capture then compares before/after campaign snapshots, receipt sets,
activation/placement watermarks, record counts, canonical entry digests, and
records. From validated records it derives, rather than trusts, both activation
and placement verified/missing/duplicate/unknown counts; rebuilding the capture
rejects any forged derived field. Evidence is ready only for exactly one
disabled-execution activation and one default-jurisdiction placement per shard
index `0..N-1`, with zero missing, duplicate, old-build, wrong-ring, mismatched,
or otherwise unknown rows.

Each accepted row must have `activation_generation=1` and be fresh for the
capture: no more than two hours before the observation start and no more than
60 seconds in the future. This prevents a stable historical ledger from being
replayed as evidence for a new campaign.

The GET path reads D1 directly. It does not resolve a Durable Object stub,
invoke readiness, or contact a Container, and the collector records
`shardDoOrContainerWakePerformed=false`.

## Capture Digest And P5 Assembly

The collector emits one canonical JSON object to stdout and writes no files.
`foundationCaptureSha256` is the SHA-256 digest of the canonical `subject`
object. `foundationCollectorSha256` is the digest of the collector code
inventory. `binding` contains the exact seven fields required by both P5
foundation evidence records:

```text
foundationCaptureContract
foundationCaptureSha256
foundationCollectorVersion
foundationCollectorSha256
observationStartedAt
observationEndedAt
paginationComplete
```

When `foundationEvidenceReady=true`, assemble the two evidence facts as:

```javascript
const candidateFreezeFacts = {
  ...capture.subject.evidenceFacts.candidateFreeze,
  ...capture.binding,
};
const remoteInventoryFacts = {
  ...capture.subject.evidenceFacts.remoteInventory,
  ...capture.binding,
};
```

Both evidence records must bind the same capture, collector, observation
window, and pagination result. The offline P5 verifier rejects any mismatch.
The signed P5 manifest also includes the actual canonical capture as the fixed
regular file `evidence/foundation-capture.json`, with its complete byte count
and file SHA-256. The verifier recomputes the capture subject digest and
requires both evidence fact objects to equal the facts emitted by that file;
binding only a copied digest string is not accepted.

`containerRuntimeBuildId` and `containerImageProvenanceSha256` remain separate
in both facts. The runtime build is the SHA-256 of the running executable; it
is not an image identity. Foundation readiness additionally requires the SBOM
source and embedded shard candidate to bind the external provenance digest
that maps that build to the exact Container image, with
`runtimeImageProvenanceVerified=true`.

## Ordered Rollout Boundary

The evidence order is fixed:

1. rotate the exposed credential and freeze commits, Worker versions, image,
   runtime build, provenance, SBOM, resources, migration, and rollback facts;
2. with every tracked action gate at its default `false`, back up D1 and
   apply/read back 0054 through 0062 in order, proving the 0062/62 and
   71/937/104 baseline while retaining the sealed 0055 campaign evidence and
   keeping every HTTP SSE and ring-transition producer disabled;
3. deploy provider-egress, Controller reader, then edge reader while activation
   recording remains false;
4. roll the Container image at 10% and 100% and prove its image/runtime identity
   with zero customer/provider/financial delta;
5. implement and approve the separate signed, single-use isolated-staging
   mutation authorization, then create the same-version, root-authorized
   one-time activation campaign, keep its nonce out of files and command
   arguments, and consume one D1-first/DO-journaled readiness claim plus one
   0061/0062 placement pair per logical shard;
6. only after the campaign is sealed and every effective action gate is false,
   capture the sealed campaign receipts, fresh stable activation ledger,
   insertion-ordered placement ledger, and all other sources-v3
   artifacts over the same 300-7200 second observation window; and
7. run and archive the direct API before/after readback with explicit terminal
   pagination before attempting the remaining P5 campaigns, signatures, or
   isolated-canary review.

The read-only endpoint and step 7 collector are implemented locally but have
not been deployed or exercised. Step 5's signed single-use mutation
authorization is not implemented, so the placement writer gates remain false.
The exposed credential must first be revoked and replaced with a separately
approved least-privilege readback identity. A live packet must then prove the
real endpoints, permissions, exact before/after inventory, and every external
source over one window. Until that authenticated capture exists, the
foundation packet and P5 decision remain **NO-GO** even if local fixtures are
complete. All tracked local/staging/production Controller action gates,
including activation recording, remain default `false`; editing the static
environment variable is not an approved workaround.

After 0058, an N-1 Worker may participate only as a reader. Foundation capture
must identify the N Worker that owns dispatch-intent recovery and prove that no
old producer can create a durable handoff without matching 0057 dispatch and
0058 client-abort ownership support.

## Fail-Closed Meaning

Foundation readiness is blocked by any absent source, partial page, candidate
identity miss, before/after drift, collector drift, unsafe HTTP/API envelope,
unknown R2 writer/object, incomplete shard registry, customer traffic,
unverified isolation, action gate, SBOM/signature issue, or source timestamp
outside the observation window.

Passing local tests proves only the collector contract and redaction boundary.
The current focused baseline passes 24 foundation collector tests with 267
assertions plus the offline self-test and 13 shard-registry/campaign collector
tests. The fixtures prove local page-number, opaque-token, single-response,
duplicate, drift, credential-reflection, timeout/envelope, and streamed-size
boundaries; they are not authenticated Cloudflare evidence. No authenticated
readback was run in this implementation increment, no remote resource changed,
and foundation, P5, and production remain **NO-GO**.

## 0060 Foundation Readback Overlay

Ordered foundation capture now applies and reads back 0054 through 0060.
Candidate-freeze and schema-readback facts must both report
`0060_relay_container_ring_transition_authority.sql`, count 60 and
69/909/101, including the exact 0058 abort, 0059 transition-claim and 0060
expiry/authority schema. Every SSE, ring-transition, provider, financial and
traffic authority remains false during collection. N-1 is reader-only; N is
the sole possible drain owner. Any older head, active claim, unexpected abort
or expiry row, provider call, financial delta, partial pagination, or candidate
drift fails closed. No authenticated remote capture occurred; foundation and
P5 remain **NO-GO**.

## 0070 Foundation Candidate Overlay

The current offline foundation candidate now reports
`0070_relay_container_drain_close_command.sql`, count 70, and the exact
`92/1463/137` schema vector. This supersedes the 0069 current-candidate
paragraph above without rewriting its historical ring-transition evidence.

The collector remains read-only and always returns `decision=not-proven`.
Advancing the candidate does not claim remote 0067/0068/0069/0070 application,
traffic-return evidence rows, a signed P5 packet, or customer eligibility.
The separate P5 `admission-fence` record remains pinned to 0068; the current
schema head and the admission authority are intentionally different
identities.
