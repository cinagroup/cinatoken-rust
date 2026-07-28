# Relay Container Shard Activation And Placement Ledger

Date: 2026-07-28

Status: local, default-inert P5 evidence implementation with the 0055 one-time
activation campaign, 0061 placement attestation ABI, and 0062 immutable event
sidecar implemented locally. The bounded placement readback and
shard-registry-v3 production contract is documented here; this docs-only
increment does not independently verify its code. No D1 migration was applied
remotely, no campaign was created or consumed, no Worker or Container was
deployed, no Durable Object or Container was woken for this document, and no
customer, provider, financial, or production authority changed.

## Operative Baseline

The current candidate D1 head is
`0062_relay_container_shard_placement_events.sql`, migration count 62, with 71
required application tables. Migration 0061 remains the frozen placement
attestation ABI; 0062 adds insertion order without modifying it. Migration
0055 remains the historical one-time activation campaign baseline and
migration 0054 remains the activation ledger beneath it. A new P5 candidate
must retain that sealed campaign evidence while binding the complete ordered
schema through 0062; none of the historical 0054-0061 baselines is a valid
current schema readback by itself.

The evidence chain has eight independently checked links:

1. the running Container runtime identifies its executable bytes;
2. the Controller binds that runtime to one Cloudflare Worker version and an
   expected runtime build gate;
3. migration 0055 claims each campaign shard before any Durable Object lookup;
4. the shard Durable Object journals one probe as started, completed, or
   ambiguous and never performs a second wake for the same claim;
5. final D1 consumption atomically projects one immutable 0054 activation fact
   and automatically seals the campaign at N/N;
6. a root-only Worker API reads the campaign receipts and a frozen 0054 D1
   snapshot without touching a shard
   Durable Object or Container; and
7. a separate root-only D1 projection reads a frozen 0062 event sequence joined
   to the immutable 0061 attestation without enumerating or waking a Durable
   Object or Container; and
8. the offline collector rebuilds every digest, joins each 0062 event/0061
   attestation pair to its 0054 activation and 0055 receipt, and derives N/N
   completeness before foundation sources v3 can consume shard-registry
   capture v3.

Breaking any link leaves the shard source `not-proven`.

## Migration 0054

Migration 0054 creates `relay_container_shard_activations` with 20 ordered
columns. It records:

- Controller Worker version ID, ring generation, shard count/index, and exact
  deterministic instance name;
- shard/runtime protocol and contract versions;
- runtime build ID, activation generation, and readiness probe generation;
- environment, Container health, readiness result, process readiness, and
  runtime/Controller execution gates;
- a cross-runtime activation digest and activation timestamp.

The schema bounds `shard_count` to `1..1024` and requires
`shard_index` in `0..shard_count-1`. The instance name must be exactly
`cinatoken-relay-shard-v1-XXXX` for that index. Runtime build and activation
digests are lowercase 64-hex SHA-256 values.

Two unique indexes enforce the immutable candidate identity:

```text
(controller_version_id, runtime_build_id, ring_generation, shard_index)
(controller_version_id, runtime_build_id, ring_generation, instance_name)
```

`BEFORE UPDATE` and `BEFORE DELETE` triggers abort every mutation. The
migration intentionally omits `IF NOT EXISTS`; duplicate critical DDL fails
instead of silently accepting an unknown schema. The local verifier checks all
five top-level statements, exact table/index/trigger shape, constraints,
uniqueness, valid readiness states, mutation rejection, and duplicate-DDL
non-mutation.

Run the schema evidence locally with:

```powershell
python tools/verify_sqlite.py
bun run check:d1:migration-config
```

The 64/814/94 numbers above come from the first command on the current worktree,
not from an estimate. They are local schema evidence only.

## Candidate Identity Chain

### Runtime executable

`crates/container-runtime/src/lib.rs` resolves the running executable with
`std::env::current_exe()`, streams it through a 64 KiB SHA-256 buffer, caches
the result through a `OnceLock`, and prewarms that cache while building the
application. `GET /readyz` returns the lowercase digest as `runtime_build_id`.
Executable resolution/read failure is cached as a typed
`runtime_build_id_unavailable` 503 response; readiness does not panic.

The build ID therefore identifies the actual runtime executable bytes. It is
not the Container image digest and does not, by itself, prove which image
delivered those bytes.

### Controller version and build gate

All Controller Wrangler configurations bind Cloudflare
`version_metadata` as `CF_VERSION_METADATA`. The activation writer uses
`CF_VERSION_METADATA.id` as `controller_version_id`.

The Controller reader accepts the historical four-field readiness response so
readers can be deployed before writers. An activation row can be recorded only
from the five-field response containing a valid `runtime_build_id` and only
when all of these conditions hold:

- `CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED` is exactly `true`;
- `CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID` is lowercase 64-hex;
- the readiness probe was live and explicitly requested a wake;
- the Container state is `healthy` and process readiness is true;
- the result is `process_ready_execution_disabled` or `execution_ready`; and
- the returned runtime build exactly equals the expected build.

A missing expected build fails with
`shard_activation_candidate_unconfigured`; a mismatch fails with
`shard_activation_runtime_build_mismatch` before D1 insertion.

`recordShardActivation` opens a first-primary D1 session and requires the 0054
migration marker, all 20 exact column names, both unique indexes with their
ordered columns, both update/delete immutability triggers with abort bodies,
and critical table constraints. It then performs an append-only insert with
conflict no-op, reads the selected identity back, recomputes the digest, and
rejects a different immutable winner as `shard_activation_conflict`. A real
in-memory SQLite test applies the exact migration and exercises this catalog
gate; P5 still separately requires a remote normalized schema fingerprint.

### Runtime build versus image provenance

P5 binds both of these independent candidate fields:

```text
containerRuntimeBuildId
containerImageProvenanceSha256
```

The activation row proves the runtime build observed by the Controller. It has
no image-provenance column and must not be presented as image proof. The P5
candidate and foundation SBOM source separately bind the exact Container image
digest, runtime build ID, image-provenance artifact digest, SBOM digest,
signature result, and `runtimeImageProvenanceVerified=true`.

The shard collector maps the P5 names to its candidate fields
`runtimeBuildId` and `imageProvenanceSha256`. Foundation sources v2 verifies
that the embedded shard capture and SBOM source both bind the same P5
candidate. This is the bridge from runtime bytes to the externally reviewed
image provenance; neither side can replace the other.

## Default-Off Gates

Tracked local, staging, and production Controller configuration keeps every
admission, execution, storage write, provider, retry, terminal, recovery,
readiness wake, and activation-recording gate at exact `false`.
`CONTAINER_SHARD_ACTIVATION_EXPECTED_RUNTIME_BUILD_ID` is empty by default.
The deploy preflight enforces those values, including
`CONTAINER_SHARD_ACTIVATION_WRITE_ENABLED=false`.

Activation recording is not enabled merely by deploying the current tree. The
legacy static writer remains disabled and must not be toggled: changing a
Worker variable creates another Controller version and breaks the same-version
evidence chain. Migration 0055 now supplies the approved dynamic capability.
A root operator can create a bounded one-time campaign only after step-up
verification, exact candidate binding, verified Controller readback, and proof
that all 22 action gates are false. The nonce is returned once, only its hash is
stored, and it is never logged.

The campaign does not make production GO. Each signed readiness request must
present the exact campaign credential; D1 atomically claims that shard before
the Controller resolves a Durable Object stub. The raw nonce is stripped before
the V2 Durable Object RPC. Runtime and Controller execution remain disabled,
and the offline collector accepts only
`readiness_result_code=process_ready_execution_disabled` with both execution
flags false. An `execution_ready` row is valid at the storage/API layer but is
an unknown candidate row for this disabled P5 source and blocks N/N evidence.

## Root-Only Read API

The evidence surface consists of the existing activation/campaign APIs and the
required 0061 placement API:

```text
GET /api/platform/container/shards/activations
GET /api/platform/container/shards/placements
POST /api/platform/container/shards/activation-campaigns
GET /api/platform/container/shards/activation-campaigns?campaign_id=<sha256>
```

The activation-list handler requires root authentication before D1 access and adds
`Cache-Control: no-store` to success and error responses. The strict query is:

```text
controller_version_id=<required>
ring_generation=<required>
high_watermark=<required after page one>
cursor=<required after page one>
limit=<optional, default 16, maximum 64>
```

Duplicate, unsupported, noncanonical, or out-of-range query values fail. A
cursor without a high watermark also fails.

Before listing rows, the handler proves that `d1_migrations` contains 0054 and
that D1 contains the table, both unique indexes, and both immutability triggers.
For the first page it selects the candidate Controller/ring maximum
`activation_id` and count. That maximum becomes the frozen high watermark.
Every later page must submit the same high watermark and uses the last returned
activation ID as an exclusive keyset cursor:

```sql
activation_id <= high_watermark
AND activation_id > cursor
ORDER BY activation_id ASC
```

Rows appended above the high watermark cannot enter the snapshot. Rows at or
below it cannot be updated or deleted because of migration 0054. The handler
fetches `limit + 1` rows to determine whether another page exists, emits the
last returned ID as `next_cursor`, and marks completion only when that cursor
is null.

Before returning a row, the Worker validates its complete shape and recomputes
`activation_digest_sha256`. The digest uses the fixed domain
`cinatoken:relay-container-shard-activation:v1\0` and a four-byte big-endian
length prefix for every identity field. The same fixed byte contract exists in
the Controller writer and offline collector.

This route reads D1 directly. It never calls `RELAY_SHARDS.getByName`, invokes
a readiness RPC, performs a Container fetch, or enumerates running instances.
Reading the activation ledger therefore does not wake a Durable Object or
Container.

### Placement-list contract

The placement-list route is separately scoped by:

```text
controller_version_id=<required>
ring_generation=<required>
campaign_id=<required lowercase sha256>
high_watermark=<omitted on page one; frozen placement_event_sequence thereafter>
cursor=<omitted on page one; last placement_event_sequence thereafter>
limit=<optional, default 16, maximum 64>
```

It authenticates root before D1 access and applies `Cache-Control: no-store`
to every outcome. Before a query, it proves the exact 0061 attestation marker,
22 ordered columns, two indexes, and three attestation guards, plus the 0062
marker, six event columns, candidate reader index, three event guards, and
attestation-after-insert append trigger. Page one freezes the scoped maximum
database-assigned `placement_event_sequence` and record count. Later pages
repeat that watermark and use:

```sql
event.placement_event_sequence <= high_watermark
AND event.placement_event_sequence > cursor
ORDER BY event.placement_event_sequence ASC
```

The handler fetches at most `limit + 1` rows. It rejects duplicate or
unsupported query parameters, changed watermarks/counts, non-increasing
cursors, unbounded traversal, malformed records, canonical-name hash drift,
and placement-attestation digest drift. The response contains
`placement_event_sequence` and `object_id_sha256`, never the raw Durable Object
ID. The event joins its 0061 attestation on digest, Controller version, ring,
campaign, and `activation_id`; that activation ID remains only the immutable
0054 relationship and is never a placement watermark or cursor.

Like the activation reader, this endpoint reads D1 only. It never enumerates
`RELAY_SHARDS`, obtains a stub, invokes a Durable Object RPC, calls a
Controller service binding, wakes a Container, writes D1, changes a gate, or
authorizes a deployment.

Migration 0062 backfills pre-existing 0061 attestations in deterministic
`recorded_at, activation_id, placement_attestation_digest_sha256` order. Every
new 0061 insert then appends one sidecar event through the fixed trigger. A
direct event insert succeeds only when digest, Controller version, ring,
campaign, and activation ID match the immutable attestation. Event update and
delete always abort.

## Shard Registry Collector

`tools/collect_relay_container_p5_shard_registry.mjs` accepts a canonical JSON
request plus one newline with contract:

```text
cinatoken-relay-container-p5-shard-registry-request-v1
```

The request is staging-only and binds exactly
`https://staging.cinatoken.com`, an integer
`observationSeconds` from 300 through 7200, and the exact Controller version,
runtime build, Container image, image provenance, ring, and shard count. Live
collection requires `--confirm-staging-readback` and a root session cookie from
`CINATOKEN_P5_SHARD_REGISTRY_COOKIE`; the cookie is not accepted as a CLI
argument or emitted in the capture. Redirects fail, every response has a
15-second timeout, and a streamed body is cancelled above 1 MiB.

Collector version 3 must record the observation start, read the sealed
campaign, fully traverse both activation and placement before snapshots, sleep
for the requested interval, record the observation end, and repeat all three
reads. The measured start-to-end interval must be at least the requested value
and no more than 7200 seconds. A slow before snapshot can therefore make a
requested upper-bound run fail rather than silently exceed the P5 window.

For each activation or placement snapshot the collector:

- uses only the root-only no-store GET route;
- adopts the first page's high watermark and sends it on every later page;
- uses page size 64 and strictly increasing keyset cursors/sequences;
- requires a terminal null cursor, complete record count, and final sequence
  equal to the frozen high watermark;
- recomputes every activation or placement digest independently;
- caps `shardCount` at 1024, total ledger records at 4096, and traversal at 65
  pages; and
- computes `entriesSha256` over canonical validated records.

Campaign, activation, and placement before/after snapshots must have the same
high watermark where applicable, total record count, entry or receipt digest,
and canonical records. The collector then derives these values from records
rather than trusting supplied totals:

```text
verifiedShardCount
missingShardCount
duplicateShardCount
unknownShardCount
```

For every candidate index `0..N-1`, exactly one row must bind the candidate
runtime, N shard count, protocol/contract version 1, staging, healthy process,
and disabled runtime/Controller execution. Missing and duplicate indexes are
counted. Every noncandidate record is counted as unknown. Evidence is ready
only when `verifiedShardCount == N` and all other derived counts are zero.
`validateShardRegistryCapture` rebuilds the entire capture and rejects changed
derived fields. Every accepted row also requires `activation_generation=1`
and an activation timestamp no more than two hours before observation start or
60 seconds in the future, preventing historical/future ledger replay.

Capture v3 additionally requires exactly one 0062 event and one 0061
attestation for each verified shard. The event/attestation pair must match the
same-shard 0054 activation and 0055 campaign receipt across campaign,
Controller version, ring, shard tuple, instance name, activation ID, claim,
readiness-result, activation, and consumption digests. Event sequences,
placement-attestation, object-ID, and canonical-name hashes must be unique
across N/N. Missing, duplicate, unknown, non-default, cross-candidate,
digest-mismatched, or drifting rows fail the capture.

The emitted capture contract is:

```text
cinatoken-relay-container-shard-registry-capture-v3
collectorVersion=3
```

Its safety boundary always states that no deploy, rollback, provider request,
remote mutation, customer-traffic authorization, or shard wake was performed
by the collector.

## Foundation Sources V3

The only current source-bundle contract is:

```text
schemaVersion=3
cinatoken-relay-container-p5-foundation-sources-v3
```

The `shardRegistry` source contains `doNamespaceIdSha256` and the full
canonical capture v3, including campaign, activation, and placement
before/after snapshots. Foundation validation:

- rebuilds the capture and all derived fields;
- binds Controller version, runtime build, image digest, image provenance,
  ring, and shard count to the P5 candidate;
- requires `sourceArtifactSha256 == SHA-256(canonical rebuilt capture)`; and
- permits source status `pass` only when `capture.evidenceReady=true`.

The source bundle and all other foundation sources must overlap the same
bounded observation window. A historical v1 aggregate N/N assertion cannot
satisfy this contract.

The P5 manifest binds the complete canonical foundation capture file at
`evidence/foundation-capture.json`, not only its subject digest. The verifier
checks file bytes, capture/collector bindings, stable readback, and exact
candidate-freeze/remote-inventory facts before owner approvals are accepted.

## Control-Plane Pagination Boundary

The activation API retains its explicit frozen keyset pagination. Foundation
collector version 4 now gives the Cloudflare control plane an equivalent local
all-pages implementation through 13 fixed direct API GET requests. KV pages
must carry stable page/count/total metadata and terminate at their exact total;
Container application and instance pages must follow bounded, unique opaque
tokens to an explicit-null terminal. Duplicate records, repeated
cursors, metadata drift, short-page inference, unexpected pagination on a
single-response endpoint, or any response bound violation fails closed.

This closes the implementation blocker, not the evidence gate. No
authenticated readback was run with a rotated credential. Foundation and P5
remain **NO-GO** until staging proves the real endpoint permissions and stable
before/after inventory together with the complete shard activation capture and
all other sources-v3 evidence.

## Ordered Staging Rollout

| Step | Required order | Evidence gate | Abort condition |
| --- | --- | --- | --- |
| S0 candidate freeze | Rotate the exposed credential, create least-privilege identities, and freeze commits, Worker versions, image, runtime build, provenance, SBOM, resources, and rollback artifacts | One canonical P5 candidate; every tracked action gate defaults false | Old credential, placeholder identity, or missing provenance |
| S1 schema readers | Back up staging D1, prove old-writer/operation drain, apply and read back the ordered chain through 0062, then deploy provider-egress, Controller reader, and edge reader with placement gates false | Exact current schema through 0062 plus sealed 0055 semantics, exact empty placement event/attestation readback, immutable negatives, and unchanged business fingerprint | Schema drift, incompatible writer, unexpected placement event/attestation, or provider/financial delta |
| S2 runtime rollout | Roll the Container candidate at 10% and then 100% while activation recording remains false | Exact control-plane image, compatible readiness/runtime build, N/N-1 reader proof, zero customer traffic | Unknown image/build, incompatible readiness, or unexplained wake/effect |
| S3 candidate recording | After separate signed single-use staging mutation authorization exists, create one root-authorized same-version campaign, retain its nonce only in the approved operator process, and issue exactly one signed readiness probe per logical shard from the exact writer-enabled staging version | D1 claim precedes every DO lookup; exact completed replays are replay-only; campaign is `sealed_complete` with N/N claims, consumptions, 0054 activations, 0061 attestations, and 0062 events | Missing/invalid/replayed authorization, version/gate/candidate drift, second wake, ambiguous journal, missing/hash-mismatched replay, failed/expired/aborted seal, stale or execution-ready receipt |
| S4 stability capture | Read the sealed campaign, activation, and placement snapshots before/after, plus action-gate, SBOM/provenance, R2, traffic, and Cloudflare inventory over one 300-7200 second window | Independent frozen 0054 activation and 0062 placement-event watermarks, complete keyset traversal, identical campaign/receipt/activation/event/attestation digests and records, strict 0054/0055/0061/0062 N/N join, exact mutation authorization/writer version, sources-v3 artifact digest, explicit Cloudflare all-pages proof | Cursor gap/repeat, placement drift/mismatch, campaign drift, receipt mismatch, source-time mismatch, any non-false frozen action gate, placement writer without exact authorization, or incomplete direct API readback |
| S5 P5 campaigns | Only after S4, run lifecycle, response/financial, provenance, load/cost/SLO, rollback, privacy, and five-owner signature gates | Ten evidence kinds and five independent signatures over one subject | Customer traffic, duplicate effect, stale evidence, failed rollback, or any unknown |

Rollback is disable-first and retains migrations 0054/0055, immutable campaign,
claim, consumption, seal and activation rows, DO journals, P3/P4 readers, R2
artifacts, and evidence. Go/VPS
remains authoritative until its separate drain and reversible-write contract
passes.

## Migration 0055 One-Time Authority

Migration 0055 adds four immutable tables, one bounded expiry-candidate view,
eight indexes, and fourteen triggers. The tables separate campaign identity,
per-shard claim, final consumption, and terminal seal. The campaign digest
binds the nonce hash, exact Controller version, 22-name all-false action-gate
inventory, foundation manifest, runtime build, ring, shard count, runtime
contracts, environment, root operator ID, and D1 validity window.

The acquisition order is a safety invariant:

1. verify the signed readiness request and campaign credential;
2. acquire or recover the exact D1 claim;
3. only then resolve `RELAY_SHARDS.getByName`;
4. call `readinessProbeV2` with probe ID, claim digest, and replay-only mode;
5. persist the canonical readiness result and SHA-256 in the Durable Object;
6. finalize D1 with that result SHA-256; and
7. let the 0055 trigger insert the matching 0054 activation and seal at N/N.

An exact already-consumed D1 claim returns completed readback even after the
campaign later seals or expires. The Controller must then use replay-only mode
and compare the Durable Object result hash with the hash stored in D1. A
missing journal, malformed result, or hash mismatch fails closed; it never
authorizes another wake.

The Durable Object schema migration
`0006_readiness_probe_at_most_once_journal_v1` stores one row per probe with an
immutable claim digest and generation. States are `started`, `completed`, and
`ambiguous`. Completion stores the exact canonical JSON, byte length, and
SHA-256. Crossing the deadline without a committed completion materializes
`ambiguous`; timeout is not treated as permission to retry the Container. A
terminal row is retained for at least two hours after the probe deadline.
Maintenance converts and deletes at most 64 rows per pass.

Only `complete/all_shards_consumed` with claimed N/N, consumed N/N, exact
receipt coverage `0..N-1`, and a matching final consumption digest is exposed
as `sealed_complete`. `failed`, `expired`, and `aborted` are terminal and cannot
promote. Once any claim, wake, activation, or consumption exists, that
candidate is retired after a non-complete terminal seal; it cannot be recycled
into a new campaign.

`GET /api/platform/container/shards/activation-campaigns` returns the complete
receipt set, not an aggregate assertion. The Worker validates candidate fields,
action gates, instance names, readiness flags, timestamps, uniqueness,
activation digests, consumption digests, and the seal's final-receipt pointer
before serializing a response. The P5 collector independently repeats those
checks and requires one matching 0054 activation per receipt.

This section supersedes every earlier S3 statement that says a same-version
campaign or receipt-aware collector is unimplemented. It does not supersede
the remote blockers: the exposed credential must be rotated, remote 0055 must
be backed up/applied/read back, a candidate must be deployed without changing
static gates, an approved live campaign must complete, and collector-v4
Cloudflare control-plane pagination must be run and archived before S4 or P5
can pass.

## Verification Boundary

Focused local commands are:

```powershell
python tools/verify_sqlite.py
bun run check:d1:migration-config
bun run check:relay-container:p5-shard-registry
bun run check:relay-container:p5-foundation
bun run check:relay-container:p5-evidence
git diff --check -- docs/relay-container-p5-evidence-contract.md `
  docs/relay-container-p5-foundation-collector.md `
  docs/relay-container-shard-activation-ledger.md
```

The most recent recorded pre-0062 event-reader results are retained as
historical evidence:

- SQLite schema verifier: pass, 60 migrations and 69/909/101 schema baseline;
- D1 migration/config audit: pass, contiguous 0001 through 0060;
- runtime readiness build-ID test: 1 pass;
- Controller activation writer tests: 5 pass, including the exact 0054 schema
  through a real SQLite catalog;
- Worker activation reader tests: 2 pass;
- Controller default-off config tests: 12 pass;
- deploy-preflight/bounded-subprocess tests: 22 pass, self-test explicitly not
  deploy-ready;
- shard-registry and campaign collector tests: 13 pass;
- foundation collector tests: 24 pass plus offline self-test; and
- P5 evidence verifier tests: 44 pass.

This docs-only increment did not rerun or replace those results. They do not
prove a 0062 event reader or shard-registry-v3 implementation. The current
schema overlay does not rewrite the sealed 0055 campaign or 0061 attestation
ABI. It adds 0056 through 0062 to candidate identity and remote readback, and
requires all HTTP SSE producer gates, the ring mutation runner, and both
placement-writer gates to remain false throughout read-only collection.

These commands test local contracts only. They cannot prove remote migration
state, deployed Worker versions, Container image provenance, authenticated all-page
Cloudflare inventory, N/N live activations, zero customer traffic, or owner
approvals. No document or local test authorizes deployment or remote mutation.
Foundation, P5, customer traffic, production cutover, and Go/VPS shutdown all
remain **NO-GO**.

## 0059 Schema Overlay

The activation ledger and sealed 0055 campaign are unchanged, but every new
candidate identity and remote readback now includes 0056/0057/0058/0059. The
exact current baseline is 59 migrations, 68 tables, 899 checked incremental
columns, 100 key indexes, and head
`0059_relay_container_ring_transition_claims.sql`. Activation collection
requires all HTTP SSE gates false, the ring mutation runner and claim authority
disabled, `enable_request_signal` present on N, N-1 reader-only, and zero
unexpected claim/step/abort/provider/financial effect. Local schema and
collector checks are not remote activation evidence. Production remains
**NO-GO**.

## 0060 Historical Head Overlay

The 0060 integrated application schema was 60 migrations, 69 required
tables, 909 checked incremental columns, 101 key indexes, and head
`0060_relay_container_ring_transition_authority.sql`. Migration 0060 adds
ring-transition expiry-authority evidence and step transport enforcement; it
does not rewrite the sealed 0055 activation campaign. Activation evidence must
bind the 0060 candidate while separately proving that the Authority Worker uses
an isolated `cinatoken-ring-control-staging` D1, not the shared application D1.
No remote migration or deployment is claimed, and production remains
**NO-GO**.

## 0061 Attestation ABI Overlay

The 0061 application schema checkpoint was 61 migrations and 70 required
tables. It adds one immutable default-jurisdiction placement row per 0054
activation/0055 consumption without changing either predecessor ABI. Migration
0062 does not change this 22-column attestation ABI.

P5 readback must still prove the exact 0061 table, 22 ordered columns, two
indexes, three original triggers, foreign keys, default-only insert guard, and
unchanged application business fingerprints. It must then prove the separate
0062 event layer below.

## 0062 Current-Head Overlay

The current application schema head is
`0062_relay_container_shard_placement_events.sql`, with migration count 62 and
71 required tables. Its six-column sidecar assigns
`placement_event_sequence INTEGER PRIMARY KEY AUTOINCREMENT`, uniquely binds
one attestation digest and one activation ID, and indexes
`(controller_version_id, ring_generation, campaign_id,
placement_event_sequence)` for the reader.

The insert guard requires complete agreement with the 0061 attestation.
Update/delete guards make events immutable and append-preserved, and the 0061
after-insert trigger automatically appends every future event. Initial
backfill is deterministic. The bounded placement route and registry v3
collector must use only `placement_event_sequence` for placement watermark,
cursor, and ordering. `activation_id` remains only the foreign-key association
to 0054.

Both placement-writer gates remain false in every tracked environment, and
ordinary deploy preflight must continue to reject an enabled value. The
separately signed, single-use staging mutation authorization does not exist.
The exposed Cloudflare token must be revoked and rotated before staging
readback. No remote 0061/0062 event/attestation pair or v3 capture has been
collected; production remains **NO-GO**.
