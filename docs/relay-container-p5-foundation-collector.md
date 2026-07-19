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
are ready for independent evidence assembly and owner review. The other eight
P5 evidence kinds, the signed manifest, and all five independent approvals are
still mandatory.

Current local baseline: D1 head 0055/count 55, 62 tables, 771 incremental
columns, and 91 key indexes. This supersedes the retained historical 0053/53
foundation text. No live Cloudflare readback, migration application,
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
foundation sources v2:

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

The collector reads only `CINATOKEN_P5_READBACK_TOKEN`. For each child process
it builds a minimal environment and maps that value to
`CLOUDFLARE_API_TOKEN`; it does not forward `HOME`, `USERPROFILE`, unrelated
credentials, or the parent environment wholesale.

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
- migration `0055_relay_container_shard_activation_campaigns.sql`, count 55; and
- response/status/financial-terminal/terminal-ACK contracts 3/4/2/3.

The earlier 0054/54 candidate was the pre-campaign activation baseline. It is
retained as history only; a new foundation request using it must fail the
current P5 candidate validator.

Unknown fields, production identities, short observation windows, candidate
drift, unsafe integers, noncanonical JSON, symbolic links, multiply linked
files, invalid UTF-8, and credential-shaped values fail closed.

## Read-Only Wrangler Allowlist

The collector invokes the repository-pinned `node_modules/wrangler/bin/wrangler.js`
through `process.execPath`, `shell=false`, a fixed argument array, bounded
stdout/stderr, fatal UTF-8 decoding, a 60-second command timeout, and process
tree termination. Only these 13 operations are accepted:

1. exact edge Worker version view and deployment list;
2. exact Controller Worker version view and deployment list;
3. exact provider-egress Worker version view and deployment list;
4. exact D1 database info;
5. exact R2 bucket info;
6. KV namespace list;
7. Container application list and exact application info, including the
   deployed `configuration.image` digest;
8. Container instance list; and
9. Container image registry list.

The allowlist rejects deploy, upload, build, push, create, update, put, get,
delete, rollback, secret, tail, SSH, execute, and wake operations. No shell is
used. Cloudflare currently requires broader Containers API permission for some
list operations than their read-only behavior suggests; that platform scope
does not expand this collector's fixed command allowlist.

Raw Wrangler output is never emitted. Each command contributes only its key,
status, byte count, canonical output digest, optional stderr digest, expected
identity result, item count, and pagination result. Any reflected credential,
invalid JSON, invalid UTF-8, output overflow, timeout, command failure,
unexpected stderr, or missing identity becomes a fail-closed blocker.

More importantly, every Wrangler list operation in the current allowlist is
classified as `unverifiable-list`. Wrangler's output does not provide the
collector enough cursor state to prove a terminal page, so deployments, KV
namespace, Container application, Container instance, and Container image
lists always return `paginationComplete=false` and `status=not-proven`. A
short first page, including fewer than 100 Container items, is not evidence of
completion. The six single-object version/D1/R2/Container-info operations can
pass locally, but the aggregate 13-command readback cannot establish
foundation readiness.

## Observation And Stability

The collector records a complete before snapshot, starts the bounded observation
after that snapshot finishes, observes for 300 through 7200 seconds, ends the
observation before starting the same 13-command after snapshot, and then records
that complete after snapshot. Readback command time therefore cannot inflate an
otherwise valid observation beyond the P5 verifier's two-hour maximum. Both
snapshots must:

- complete without unsafe output;
- prove their bounded pagination;
- contain every exact candidate identity;
- have empty stderr; and
- have the same canonical digest.

The two P5 evidence records must be captured no later than 15 minutes after the
foundation observation ends. The offline verifier rejects a longer sealing
lag even when the original window length was valid.

The collector code inventory is also hashed before and after the observation.
It includes the collector, readback library, bounded subprocess library, P5
evidence contract, shard registry collector/library, root package/lock files,
and the installed Wrangler package, launcher, and executable CLI bundle. Any
tool or pinned Wrangler artifact drift blocks foundation readiness.

The registry list is stability inventory, not image-digest proof: pinned
Wrangler filters digest tags from `containers images list`. The exact candidate
digest must instead match the Container application's `configuration.image`
field as either the digest itself or the digest suffix of an image reference;
the independent SBOM source must bind the same digest.

## Required External Sources

Wrangler control-plane output is not a complete shard ledger. In particular,
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
| `shardRegistry` | stable embedded app-owned activation capture, exact Controller/runtime/ring candidate, derived N/N verified shards |
| `r2Inventory` | complete writer/object inventory with zero unknown writers and zero unknown objects |
| `traffic` | zero customer traffic and verified staging isolation |

Each source carries `status`, `collectorId`, `collectorVersion`, and
`sourceArtifactSha256`. The source bundle is bounded to 4 MiB so a canonical
1024-shard capture can fit without making input unbounded. For action gates,
SBOM, R2, and traffic, the digest must equal canonical JSON of the exact source
record with only `sourceArtifactSha256` removed. For `shardRegistry`, the
foundation validator rebuilds the embedded capture and requires the digest to
equal that canonical capture. These are integrity bindings; source provenance
and any external signature must still be retained for owner review.
`unknown` and `fail` are representable but always block foundation readiness.
Omitting the bundle yields explicit blockers for all five sources and sets
`binding.paginationComplete=false`.

## Shard Activation Source

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
`GET /api/platform/container/shards/activations`. The campaign readback must be
`sealed_complete`, bind the exact candidate and foundation manifest, and carry
one validated consumption receipt per shard. The first activation response freezes
`high_watermark`; every later request sends that same value plus the previous
page's keyset cursor. Pages contain at most 64 records, sequences and cursors
must increase strictly, the terminal page must return `next_cursor=null`, and
the flattened record count and last sequence must equal `total_records` and
the frozen high watermark. The collector caps this evidence inventory at 4096
ledger records and 65 pages; exceeding either bound fails closed.

The Worker reader and the offline collector independently recompute every
`activation_digest_sha256` and `consumption_digest_sha256` using the same
length-prefixed domain-separated contracts as the Controller writer. Each
receipt must match exactly one 0054 activation. The capture then compares
before/after campaign snapshots, receipt sets, high watermarks, record counts,
canonical entry digests, and records. From the
validated records it derives, rather than trusts, `verifiedShardCount`,
`missingShardCount`, `duplicateShardCount`, and `unknownShardCount`; rebuilding
the capture rejects any forged derived count. Evidence is ready only for
exactly one disabled-execution candidate row per shard index `0..N-1` and zero
missing, duplicate, old-build, wrong-ring, or otherwise unknown rows.

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
   apply/read back 0054 then 0055, proving the 0055/55 and 62/771/91 baseline;
3. deploy provider-egress, Controller reader, then edge reader while activation
   recording remains false;
4. roll the Container image at 10% and 100% and prove its image/runtime identity
   with zero customer/provider/financial delta;
5. create the implemented same-version, root-authorized one-time activation
   campaign, keep its nonce out of files and command arguments, and consume one
   D1-first/DO-journaled readiness claim per logical shard without changing a
   static activation environment variable;
6. only after the campaign is sealed and every effective action gate is false,
   capture the sealed campaign receipts, fresh stable activation ledger, and
   all other sources-v3
   artifacts over the same 300-7200 second observation window; and
7. perform explicit full Cloudflare control-plane pagination before attempting
   the remaining P5 campaigns, signatures, or isolated-canary review.

Step 5 is implemented locally but has not been deployed or exercised. Step 7
remains unimplemented because the current Wrangler list reader cannot prove
terminal pagination. Therefore
the foundation packet and P5 decision remain **NO-GO** even if a local shard
fixture is complete. All tracked local/staging/production Controller action
gates, including activation recording, remain default `false`; editing the
static environment variable is not an approved workaround.

## Fail-Closed Meaning

Foundation readiness is blocked by any absent source, partial page, candidate
identity miss, before/after drift, collector drift, nonempty Wrangler stderr,
unknown R2 writer/object, incomplete shard registry, customer traffic,
unverified isolation, action gate, SBOM/signature issue, or source timestamp
outside the observation window.

Passing local tests proves only the collector contract and redaction boundary.
The current worktree passes 16 foundation collector tests plus the offline
self-test and 13 shard-registry/campaign collector tests. Those fixtures inject complete
pagination where needed; they do not make Wrangler list output complete.
The current Wrangler list pagination boundary intentionally prevents a live
foundation pass until an explicit all-pages reader is implemented. No
authenticated readback was run in this implementation increment, no remote
resource changed, and foundation, P5, and production remain **NO-GO**.
