# Relay Container P5 Evidence Contract

Date: 2026-07-19

Status: local, credential-free, campaign-aware evidence-verifier candidate. It authorizes no
remote mutation, customer traffic, production cutover, or Go/VPS shutdown.

Current candidate baseline: migration head
`0072_relay_container_drain_source_authorization.sql`, migration count 72,
and the locally verified schema shape of 99 required tables, 1611 checked
incremental columns, and 148 key indexes. This baseline supersedes every
earlier current-candidate head/count retained below. Nothing in this document
claims that 0072 was applied, deployed, or read back from Cloudflare.

Migration 0068 remains the immutable admission-fence evidence identity, and
0063 remains shard-placement authorization storage provenance. Advancing the
current schema head to 0072 does not relabel either historical authority.

Historical activation baseline, retained for continuity: 0054 ended at 54
migrations with 58 tables, 694 incremental columns, and 83 key indexes. Those
values describe the pre-campaign state and cannot satisfy the current P5
verifier.

## Purpose

P3 and P4 close the local response and financial terminal contracts. P5 must
prove those contracts on real Cloudflare infrastructure before any traffic
authority can move from Go/VPS. Free-form smoke notes are useful operational
context, but they cannot prove that every result belongs to one immutable
candidate, remains fresh, and has all required approvals.

This document defines the first machine-readable P5 decision:

`isolated-staging-synthetic-canary`

The verifier can declare only that a fully evidenced packet is eligible for
human review of that isolated staging decision. It always returns customer and
production eligibility as false. A later production-cutover packet must add
the Go/VPS drain and reversible-data requirements in this document.

## Source And Platform Constraints

The source repositories are frozen for this contract at:

- cinaVibeSDK `918e97480ee44e357abe99bf33c27259d6ac7ebd`;
- Go cinatoken `73652508abc5cb09214dde02d51d69d1d1ccc703`; and
- the exact cinatoken-rust candidate commit named by the packet.

Cloudflare's current platform documentation establishes these constraints:

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
  require bounded buffering, bindings instead of REST from Workers, Service
  Bindings for Worker-to-Worker calls, complete Promise ownership, secrets
  outside source, and observability before production.
- [Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
  routes a request through a Worker and a Container-backed Durable Object.
  The DO and Container are not guaranteed to be colocated, restart placement
  may change, and Container disk is ephemeral.
- [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
  can create Worker-to-Worker version skew; a Service Binding subrequest may
  reach a different downstream version unless the campaign pins or isolates it.
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
  record ordered files in `d1_migrations`; Cloudflare recommends the stable
  database name rather than a mutable binding name for migration commands.

cinaVibeSDK remains a lifecycle reference, not proof for this system. Its real
execution path has an Agent DO and a separate Sandbox DO before the Container.
It uses deterministic identity, useful lifecycle hooks, and SDK/image version
alignment, but it also contains process-local recovery, fail-open readiness,
ephemeral metadata, direct preview bypass, and a one-step rollout. cinatoken-rust
therefore retains one canonical `RelayShardContainer` DO as shard coordinator,
durable lifecycle owner, and bound Container supervisor.

The Go source remains the business-policy authority, but its deployment cannot
be stopped merely because HTTP ingress looks quiet:

- deferred user, token, channel, usage, and request deltas live in process maps;
- a failed batch flush is logged after the active map has been swapped out;
- `BillingSession` settlement/refund state is request-process memory and some
  updates are multi-step;
- `/api/status` is public configuration health, not dependency readiness; and
- scheduler/master ownership is configuration-based rather than leased.

These findings require an explicit Go drain and reconciliation gate before
production cutover. They do not block an isolated Cloudflare staging campaign
that receives no customer traffic and leaves Go/VPS authoritative.

## Files And Commands

The implementation is:

- `tools/relay_container_p5_evidence_contract.mjs`;
- `tools/verify_relay_container_p5_evidence.mjs`; and
- `tests/relay-container-p5-evidence.test.mjs`.

The staging foundation collector is:

- `tools/collect_relay_container_p5_foundation.mjs`;
- `tools/lib/cloudflare_readback.mjs`;
- `tests/relay-container-p5-foundation-collector.test.mjs`; and
- `docs/relay-container-p5-foundation-collector.md`.

The application-owned shard activation evidence path is:

- `migrations/d1/0054_relay_container_shard_activations.sql`;
- `tools/collect_relay_container_p5_shard_registry.mjs`;
- `tools/lib/relay_container_shard_registry.mjs`;
- `tests/relay-container-p5-shard-registry.test.mjs`; and
- `docs/relay-container-shard-activation-ledger.md`.

The separately versioned production Go/VPS gate is:

- `tools/go_vps_cutover_evidence_contract.mjs`;
- `tools/verify_go_vps_cutover_evidence.mjs`;
- `tests/go-vps-cutover-evidence.test.mjs`; and
- `docs/go-vps-cutover-evidence-contract.md`.

The supporting disabled-deploy boundary is:

- `tools/preflight_container_controller_deploy.mjs`; and
- `tests/container-controller-deploy-preflight.test.mjs`.

Inspect the contract without credentials or network access:

```powershell
bun run plan:relay-container:p5-evidence
bun run plan:go-vps-cutover:evidence
```

Run the adversarial local contract suite:

```powershell
bun run check:relay-container:p5-evidence
bun run check:relay-container:p5-foundation
bun run check:relay-container:p5-shard-registry
bun run check:go-vps-cutover:evidence
bun run check:container-controller:deploy-preflight
```

After replacement credentials are configured, the live staging preflight uses
read-only Wrangler secret inventories and is automatically required by the
Controller deploy command:

```powershell
bun run preflight:container-controller:staging
bun run deploy:container-controller:staging
```

The tracked production config intentionally fails the equivalent preflight
until every `REPLACE_WITH_*` resource ID is replaced and authenticated
resource readback has been archived.

Verify a real packet only after collectors and reviewers have produced it:

```powershell
bun run verify:relay-container:p5-evidence -- `
  --manifest C:\secure-evidence\candidate\manifest.json `
  --trust-policy C:\release-trust\staging-p5-policy.json `
  --json
```

The trust policy must be outside the evidence-bundle directory. Its five role
keys must also have distinct public-key fingerprints. The verifier does not
read credential environment variables, call `fetch`, spawn Wrangler, write
files, or handle private signing keys. The separate deploy preflight can issue
only bounded, argument-array `wrangler secret list` calls; it cannot deploy or
mutate resources.

The foundation collector is also staging-only and read-only. It binds the
`candidate-freeze` and `remote-inventory` facts to one canonical capture,
collector artifact digest, five-minute-to-two-hour observation window, and
complete pagination result. Collector version 4 replaces the former Wrangler
plan with 13 fixed, credential-free Cloudflare API GET requests for exact
Worker version/deployment, D1, R2, KV, and Container readback. It emits digests
and structural status metadata rather than raw control-plane output.

The direct reader traverses strict KV page numbers and opaque Container page
tokens to explicit-null terminal conditions, rejects duplicate records, token
loops, metadata drift, short-page inference, unsafe envelopes, redirects,
per-request/whole-readback timeout, and bounded-response violations, and treats
official non-paginated endpoints as single responses only when they contain no
pagination metadata. It requires the first Worker deployment to carry the
candidate at 100%, nonempty current Container placements to use the candidate
image, endpoint-specific result schemas, and a recomputed digest over all 13
strict summary records. This closes
the local pagination implementation blocker. Foundation and P5 remain
**NO-GO** until a rotated least-privilege token has produced stable,
authenticated before/after readback and all independent evidence sources.

Cloudflare Container instance inventory cannot prove sleeping Durable Object
members. The collector therefore requires a stable app-owned shard activation
ledger plus separate action-gate, SBOM/signature/provenance, R2 writer/object,
and traffic-isolation sources. The shard source embeds the canonical capture
under foundation sources v3 and binds its recomputed
`sourceArtifactSha256`. Missing or incomplete sources produce explicit
blockers and `paginationComplete=false`; they can never be converted into a
P5 pass by elapsed time. The complete contracts and live SOP are in
`docs/relay-container-p5-foundation-collector.md` and
`docs/relay-container-shard-activation-ledger.md`.

## Manifest Identity

The operative manifest is schema version 3 with contract
`cinatoken-relay-container-p5-promotion-manifest-v3`. Version 3 adds the
required `admission-fence` evidence item and requires every evidence envelope
to bind the same canonical foundation capture digest. Version 1 and version 2
manifests cannot be upgraded by inserting optional fields and are rejected.
Evidence envelopes use
`cinatoken-relay-container-p5-evidence-v2`.

Every input is canonical JSON: object keys are sorted, numbers are safe
integers, and the file ends with exactly one newline. This rejects duplicate
or parser-dependent JSON representations before signatures are evaluated.

The signed subject binds:

- policy ID, staging environment, decision, generation and expiry times;
- repository and both source commits;
- edge, Controller, provider-egress, Container image, runtime executable build,
  and runtime-to-image provenance identities;
- Container SBOM digest and image signature result;
- exact D1 name/UUID, R2 bucket, KV namespace digest, Controller/egress service,
  DO namespace digest, binding, class, shard count, and ring generation;
- D1 head 0072 and count 72, with exact 99-table, 1611-column, and
  148-index readback totals;
- response protocol 3, status contract 4, financial terminal contract 2, and
  terminal ACK contract 3;
- a bounded, non-streaming, synthetic `/v1/chat/completions` cohort with no
  customer traffic; and
- the fixed `evidence/foundation-capture.json` path, byte length, and complete
  file SHA-256 digest; and
- the path, byte length, SHA-256 digest, capture time, and expiry of every
  evidence file, plus the fixed 11-file admission-fence supporting-artifact
  inventory.

The subject digest is SHA-256 over canonical subject JSON. Every evidence file
binds the same candidate and foundation-capture digests. A packet cannot mix
schema evidence from one commit, lifecycle evidence from another image,
admission evidence from another D1 capture, and approval from a third
deployment.

## Required Evidence

All eleven kinds are required exactly once and in contract order:

| Kind | Required proof |
| --- | --- |
| `candidate-freeze` | Exact commit/version/image/runtime-build/provenance/SBOM inventory, image signature and runtime-to-image provenance verified, zero unapproved critical/high vulnerabilities, every action gate false |
| `remote-inventory` | Account digest, exact shared D1/KV/R2 identities, Controller/egress services, DO namespace/binding/class, candidate runtime build and image provenance, all shards accounted for, zero unknown writers/objects/customer traffic |
| `reader-first-rollout` | Egress before Controller, Controller before edge, readers before writers, every shard on a compatible reader, no new response write, public `/internal` 404, N/N-1 or blue/green skew proof |
| `schema-readback` | Remote 0071/71 and exact 97-table/1550-column/144-index baseline, normalized schema digest, unchanged business fingerprint, old-writer and direct-negative probes with zero provider/financial delta |
| `admission-fence` | Exact staging D1/account/scope binding, 0068 SQL and schema inventory, bounded historical backfill, N/N-1 writer drain, five false write gates, one successful fenced admission, one-step close/campaign readback, close races, rejection/replay outcomes, and 11 canonical supporting-artifact digests |
| `lifecycle-fault-campaign` | Cold/warm start, DO eviction, Container sleep/restart/OOM, duplicate alarm, callback failure, malformed/future payload, N-1, and response loss; zero duplicate provider/financial effects |
| `response-financial-fault-campaign` | Success, typed error, HTTP error, invalid body, and recovery; every D1 statement fault; response-class totals equal provider operations, one provider operation per send, settled plus refunded terminal conservation, zero request accounting on refund, exact client replay and classified R2 orphans |
| `cross-layer-provenance` | Complete redacted edge/Controller/DO/Container/broker/provider/D1/R2/financial/audit/client tuple with no identity gap or payload/credential leak |
| `load-cost-slo` | At least one hour and 1,000 requests, Rust 5xx delta at most 50 basis points, non-stream p95 overhead at most 300 ms, zero D1/resource errors, delivered alert drills, approved 1x/2x/5x cost |
| `rollback-rehearsal` | Exact admission capture/fence/generation/campaign/accepted-set binding, gates disabled first and read back false, immutable scope head/closed fence/commit count, rejected reopen, all in-flight work classified, zero new Rust admission/resend/duplicate finance, Go authority restored, P3 readers/0054/0068/evidence retained, rollback within 15 minutes |
| `security-privacy-review` | Replacement least-privilege credential readback, zero secret/unredacted payload/critical/unapproved-high findings, approved retention/privacy, named incident owner |

An evidence envelope that merely says `status=pass` is insufficient. Each kind
has an exact fact schema and hard thresholds in the verifier. Unknown or missing
fields fail closed.

`candidate-freeze` and `remote-inventory` additionally carry the same seven
foundation-binding fields: capture contract/digest, collector version/digest,
observation start/end, and `paginationComplete=true`. Their observation is at
least five minutes and at most two hours and ends before both evidence
captures. Any mismatch rejects the whole packet.
The evidence must be sealed within 15 minutes after the foundation observation
ends; an otherwise valid but old control-plane window is rejected.

The manifest must also carry the actual canonical foundation capture as
`evidence/foundation-capture.json`; a digest string copied into two evidence
records is insufficient. The verifier opens that regular non-symlink file
under the bundle root, enforces a 4 MiB bound, checks its complete-file digest,
recomputes the collector subject digest, validates ready/stable/paginated
readback and the hard-false safety boundary, then requires the capture's
candidate-freeze and remote-inventory facts to equal the two evidence records
after removing their seven shared binding fields. The five owner signatures
therefore bind the capture bytes through the signed manifest subject.

The operative external-source bundle is schema version 3 with contract
`cinatoken-relay-container-p5-foundation-sources-v3`. Its `shardRegistry`
source embeds the complete before/after campaign-aware activation capture and must set
`sourceArtifactSha256` to the SHA-256 of the collector's canonical rebuilt
capture. A v1 aggregate N/N assertion is historical context only and cannot
satisfy this baseline.

`containerRuntimeBuildId` and `containerImageProvenanceSha256` are independent
candidate fields. The first is SHA-256 of the running runtime executable. It
does not prove which Container image supplied that executable. The second
binds the external provenance artifact that maps the runtime build to the
candidate image; the SBOM source must bind both and assert
`runtimeImageProvenanceVerified=true`.

## Trust And Approval

The trust policy is an independent root and contains only Ed25519 public keys.
It is valid for staging, has a bounded validity window and clock skew, and maps
keys to exactly one owner role. Private keys never enter the repository,
evidence bundle, CLI, or verifier process.

The five required roles are:

1. security;
2. finance;
3. operations;
4. product; and
5. rollback.

Each role must use a distinct key ID and distinct Ed25519 public-key fingerprint
and sign after the newest evidence file was captured. Evidence capture cannot
follow manifest generation, approval signing cannot reach or exceed decision
expiry, and an already elapsed cohort fails. Every signature and key must
remain valid through the decision expiry. The signed bytes are:

```text
cinatoken-relay-container-p5-approval-v1
<policy-id>
staging
<role>
<key-id>
<subject-sha256>
<signed-at>
<expires-at>

```

The manifest cannot carry its own trust policy. Changing any candidate,
cohort, artifact hash, timestamp, or path changes the subject digest and
invalidates all five approvals. Evidence files must be regular non-symlink
files, and every evidence and approval validity window must increase strictly.

## Reader-First Campaign Order

1. Rotate the exposed credential and create separate least-privilege deploy
   and readback identities. Do not place either value in a command argument.
2. Freeze commit, Worker versions, Container image digest, runtime executable
   build ID, SBOM/signature, runtime-to-image provenance, resource identities,
   migration SQL, and rollback artifacts. Every tracked local, staging, and
   production action gate defaults to false.
3. Back up staging D1, prove old-writer and operation drain, apply/read back
   the ordered reader chain through 0062, including the exact 0054 activation,
   0055 campaign, 0061 attestation, and 0062 placement-event tables, indexes,
   triggers, foreign keys and initial row counts, with immutable negatives and
   unchanged business fingerprints.
4. Upload a disabled provider-egress version, then a Controller reader, then an
   edge reader with the private Service Binding. Activation recording remains
   false and the Controller accepts both legacy and build-bearing readiness.
5. Roll the Container candidate at 10% and 100%. At each stage read back the
   exact image, compatible runtime protocol/build, zero customer traffic, and
   zero provider/financial delta.
6. Only after the separate signed, single-use isolated-staging mutation
   authorization exists, use it to bind one immutable writer-enabled
   Controller version with both placement gates true while all frozen 22
   campaign action gates remain false. Create one root-authorized activation
   campaign for that exact version and use its one-time nonce. D1 must claim
   each shard before DO lookup; completed claims use replay-only journal reads;
   only a `sealed_complete` N/N campaign with one 0061 attestation and matching
   0062 event per shard can continue.
7. After that campaign is sealed, capture the root-only campaign receipts plus
   the 0054 activation and 0062 event-backed 0061 placement ledgers before and
   after 300-7200 seconds. The activation ledger retains its 0054
   `activation_id` boundary; the placement ledger independently freezes
   `placement_event_sequence`. Receipts, activations, events, and attestations
   must match one-to-one per shard and remain byte-canonically stable. The
   evidence must retain the exact mutation authorization and writer version
   while sources-v3 22-field action-gate, SBOM/provenance, R2,
   traffic-isolation, and control-plane facts overlap the same window.
8. Run and archive collector-v4 direct API readback with explicit terminal
   pagination for every Cloudflare control-plane list. Until the authenticated
   before/after capture passes, foundation and P5 remain `not-proven`
   regardless of the activation ledger result.
9. Run lifecycle and response/financial fault campaigns against a bounded
   synthetic cohort. Pin or blue/green-isolate downstream Service Binding
   versions during skew tests.
10. Run load/cost/SLO and alert drills, then disable-first rollback while Go/VPS
   remains authoritative.
11. Build canonical evidence files and manifest. Five owners independently
   review the exact subject digest and sign it.
12. Run the offline verifier. A pass permits only release-commander review of
   the isolated staging synthetic canary.

## Production Cutover Extension

The P5 verifier intentionally cannot authorize customer traffic or production
cutover. The separately versioned Go/VPS contract now verifies these eight
evidence kinds without credentials, network, shell, SQL, or file writes:

1. live topology: binary/image commit and digest, replicas, DNS/LB, SQL dialect,
   separate LOG_DB state, Redis, and exactly one owner for each scheduler loop;
2. ingress drain: relay, task, SSE, and WebSocket acceptance stopped at a fixed
   timestamp, with LB and OS connection counts at zero;
3. process-state drain: no in-flight `BillingSession`, pending refund, pending
   asynchronous task handoff, or process-local accounting delta;
4. flush stability: at least two complete batch intervals and one data-export
   interval, two stable SQL snapshots, and zero batch/settle/refund/log errors;
5. source/target reconciliation: DDL, row counts, primary-key high-watermarks,
   canonical chunk hashes, quota/request/channel/subscription/task facts, and
   active LOG_DB evidence with zero unexplained difference;
6. reversible writes: zero CDC lag at freeze and reverse synchronization of
   every Cloudflare write needed by the hot Go rollback target;
7. pending tasks/orders: empty or durably handed off with exact target
   readback and zero unaccounted work; and
8. measured rollback: RTO/RPO, session continuity, restored Go readiness, and
   a current rollback database containing all accepted writes.

Run its local contract and inspect its decision vocabulary with:

```powershell
bun run check:go-vps-cutover:evidence
bun run plan:go-vps-cutover:evidence
```

A complete packet returns only
`eligible-for-production-cutover-review`. It always returns
`productionCutoverAuthorized=false`; a release decision remains independent.

Elapsed time and `/api/status` alone are never drain evidence. `quota_data` and
pre-consume rows are supporting facts, not proof that process-owned settlement
has converged. If reverse synchronization is absent after Cloudflare accepts a
write, Go/VPS is no longer a safe rollback target.

## Local Verification Boundary

The local test suite uses temporary in-memory Ed25519 owners and canonical
files to prove the verifier accepts one complete fixture and rejects
noncanonical JSON, digest drift, candidate drift, customer traffic, stale
evidence, writer-before-reader ordering, missing lifecycle/provenance, duplicate
provider or financial effects, refund accounting, weak load, unsafe rollback,
path traversal, bundled trust roots, missing/stale/wrong-role/tampered approvals,
and evidence that expires before the decision.

The historical pre-0054 focused run recorded 38 P5 verifier tests, 14
foundation collector tests plus its offline self-test, 23 Go/VPS cutover
tests, and 22 bounded-subprocess/deploy-preflight tests. That count is retained
as history, not as current 0054 activation evidence. The current baseline also
requires `python tools/verify_sqlite.py` and
`bun run check:relay-container:p5-shard-registry`; report their actual output
and never infer a pass from this paragraph.

On the current worktree, the focused candidate checks pass the 59-migration
68/899/100 SQLite verifier, 44 P5 verifier tests, 24 foundation collector tests
plus its offline self-test, 13 shard-registry/campaign collector tests, and 22 deploy-preflight
tests. These are still local contract checks, not Cloudflare evidence.

The signed candidate and schema-readback facts now require exact migration head
`0059_relay_container_ring_transition_claims.sql`, count 59, and 68/899/100 totals.
Historical sealed 0055 activation evidence remains valid only when the current
candidate also proves ordered 0056/0057/0058/0059 compatibility. A pre-0059 packet is
rejected and cannot be relabeled as current evidence.

Those fixtures are tests of the verifier, not Cloudflare evidence. No remote
resource, credential, provider, financial row, deployment, or traffic state was
changed. Production remains **NO-GO**.

## 0059 Candidate Identity Overlay

Every new P5 packet must bind migration head
`0059_relay_container_ring_transition_claims.sql`, count 59, and exact
68-table/899-column/100-index totals. A 0058 packet is historical and cannot be
relabeled as the current candidate.

Schema readback must include the exact seven-column abort table, observation
index, five triggers, both 0059 claim/step tables, three named claim indexes,
seven claim/step triggers, normalized schema digest, `enable_request_signal`
compatibility, all four SSE gates false, the ring runner disabled, and zero
unexpected claim/step/abort/provider/financial effect during the observation
window. The remote fault packet must add claim races, response-loss readback,
HTTP/2, HTTP/3, TCP and WFP cancellation, D1 ambiguity, restart/version-skew,
invoice and rollback evidence. Local fixture acceptance does not authorize
traffic. Production remains **NO-GO**.

## 0060 Candidate And Authority Isolation Overlay

This overlay supersedes only the current candidate identity in the 0059
overlay. Historical sealed evidence remains historical. Every new integrated
workspace P5 candidate must bind current head/count `0060/60`:

```text
migration head: 0060_relay_container_ring_transition_authority.sql
migration count: 60
required tables: 69
checked incremental columns: 909
key indexes: 101
```

The schema evidence must bind the exact 0059 and 0060 file digests, the
expiry-event table and index, `transport_outcome`, recreated claim/step guards,
normalized schema digest, and negative results proving:

- the temporary drain guard rejects any old 0059 writer or active transition
  claim before the incompatible migration is applied;
- expiry authority is a server-derived actor distinct from the claim owner;
- pre-mutation expiry becomes `expired`;
- post-mutation expiry becomes `recovery_required`;
- inflight mutation ownership remains readback-only;
- post-readback mutation digest equals the immediately preceding intent; and
- `transport_outcome=rejected` can only be
  `recovery_required/http_rejected`.

### Separate control-plane evidence

The P5 packet must not present the integrated `69/909/101` total as evidence for
the dedicated control D1. A separate
`ring-transition-control-plane-v1` evidence item must bind:

1. `cinatoken-ring-control-staging` database identity hash, jurisdiction,
   migration-lineage digest, 0059/0060 source digests, normalized catalog
   digest, backup/Time Travel point, restore rehearsal, retention and owners;
2. exactly the claim, step and expiry domain tables, plus only
   provider-managed migration metadata, with no unrelated application table;
3. the frozen Authority Worker version and source/config/provenance digests;
4. exactly one D1 binding to the control database plus Version Metadata, and
   absence of application D1, KV, R2, Durable Object, Container, Queue,
   service, AI, browser and arbitrary outbound authority;
5. `workers_dev=false`, `preview_urls=false`, no production configuration, and
   authority/claim/step/expiry write gates false;
6. the Access application/policy identity and route inventory proving no
   workers.dev, preview, alternate domain or route bypass;
7. application-HMAC key ID and policy digest without secret material, including
   method/path/time/request/body/credential binding and replay-window results;
8. Ed25519 permit policy/public-key fingerprints and claim-binding test results,
   without private key or permit reuse;
9. server-derived credential and expiry-actor identity, exact
   create/read/step/expiry results, concurrency and response-loss readback
   evidence; and
10. before/after zero customer, provider, financial, traffic and shared
   application-D1 delta.

The current local Authority Worker configuration names
`cinatoken-ring-control-staging`, and the retained config audit proves the
shared application database name is absent. It remains ineligible for a
`ring-transition-control-plane-v1` evidence item because its database ID and
trust identities are placeholders, every write gate is false, and no
authenticated remote database, route, Access, key-rotation, or revocation
packet exists.

The evidence item is incomplete if it contains a secret, raw authorization
header, Access secret, HMAC value, private key, raw request body, SQL error, or
unredacted D1 metadata. Local fixtures and schema replay remain
`not-remote-proven`.

No Authority Worker, control D1, Access policy, route, secret, key, migration,
deployment, customer traffic, provider call, or financial state is claimed as
remotely created or changed. The checked-in write gates remain required false,
Go/VPS remains authoritative, and production remains **NO-GO**.

## 0062 Placement Event Readback And Registry v3 Overlay

Every new integrated P5 candidate must bind the 0063 application head,
migration count 63, and the 72-table application schema. The underlying 0061
attestation and 0062 event ABIs remain unchanged. Historical 0054/0055/0061/
0062 evidence remains historical unless it is joined to the same current
candidate and exact 0063 schema readback.

The sidecar exists because `activation_id` is only the immutable association
to 0054. A later placement can legitimately reference an older activation, so
neither P5 nor the API may infer placement insertion order from that value.
Database-assigned `placement_event_sequence` is the sole placement watermark
and cursor.

### Read-only source boundary

Placement evidence comes only from:

```text
GET /api/platform/container/shards/placements
```

The endpoint must authenticate root before D1 access and return
`Cache-Control: no-store` for success and errors. It reads D1 only. Evidence is
invalid if collection enumerates the Durable Object namespace, derives or
fetches a stub, invokes an object RPC, calls a Controller service binding,
wakes a Container, mutates storage, or changes a runtime/deployment gate.

The request binds exact `controller_version_id`, `ring_generation`, and
`campaign_id`. Page one freezes the maximum `placement_event_sequence` and
scoped record count. Each continuation repeats that watermark and advances an
exclusive event-sequence cursor; pages are ordered ascending, capped at 64
records, and use one bounded lookahead row. The collector rejects count or
watermark drift, cursor gaps/repeats, nonterminal short pages, over-limit
traversal, or a final cursor inconsistent with the frozen snapshot.

The Worker and collector independently validate the exact 0061 attestation
shape and the 0062 six-column event table, candidate index, three event guards,
and attestation-after-insert append trigger. The reader joins event to
attestation on digest, Controller version, ring, campaign, and activation ID,
then validates canonical shard identity, canonical-name SHA-256, and
`ShardPlacementAttestationV1` digest. Retained records contain
`placement_event_sequence` and only the object-ID hash, never the raw Durable
Object ID.

### Capture v3 acceptance

The accepted source contract is:

```text
cinatoken-relay-container-shard-registry-capture-v3
collectorVersion=3
```

One v3 artifact contains sealed 0055 campaign, frozen 0054 activation, and
frozen 0062 event-backed 0061 placement snapshots before and after the same
300-7200 second window. Each source must preserve its high watermark, record
count, canonical record-set digest, and full canonical rows. Foundation and P5
bind the complete v3 artifact and its SHA-256; an aggregate N/N assertion is
insufficient.

For every candidate index `0..N-1`, the verifier requires exactly one campaign
receipt, one activation, one placement event, and one attestation. The
event/attestation pair must equal the same-shard 0054/0055 evidence across
campaign, Controller version, ring, shard count/index/name, activation ID,
claim digest, readiness-result digest, activation digest, and consumption
digest. Event sequences, placement-attestation, object-ID, and canonical-name
hashes must each be unique across N/N. Any missing, duplicate, unknown,
cross-campaign, cross-version, cross-ring, non-default-jurisdiction,
digest-mismatched, or before/after-drifting row makes the source `not-proven`.

The read-only source does not grant mutation authority. Both placement-writer
gates remain false and ordinary deploy preflight must reject them when true.
The 0063 verifier and D1 single-use consumption exist locally, but the
four-role Authority issuer, deployment runner, and P5 authorization-row source
are not implemented. The exposed Cloudflare token must be revoked and rotated
before authenticated staging work.

No remote 0061/0062/0063 schema, placement event/attestation pair, v3 capture,
deployment, customer traffic, or production authority is claimed by this
contract. Go/VPS remains authoritative and production remains **NO-GO**.

## 0063 Placement Mutation Authorization Overlay

Migration 0063 adds the staging-only authorization that must precede every
current activation campaign and placement append. P5 must retain the exact
authorization row joined to its campaign, but it must never retain the raw
campaign nonce, execution nonce, signature, SPKI bytes, authorization header,
private key, or request body.

The accepted authorization evidence must prove:

1. exact 0063 table, index, campaign guard, immutable guards, and replacement
   placement guard;
2. one unique authorization, execution nonce hash, campaign nonce hash,
   signed-subject digest, campaign ID, and campaign digest;
3. fixed staging environment and Controller service;
4. exact issuer, key ID, signer SPKI fingerprint, Controller version, runtime
   build, action-gate inventory, foundation manifest, ring, shard count,
   campaign lifetime, and consuming administrator;
5. permit issue/expiry and D1-derived consumption times within the frozen
   v1 windows;
6. exact campaign and authorization readback from the same atomic D1 batch;
7. authorization consumption before Controller claim, Durable Object lookup,
   Container wake, and placement append; and
8. disabled writer-gate and credential-revocation readback after collection.

The current capture-v3 collector does not ingest this row. Until a versioned
collector and foundation manifest bind it, a placement capture is
`not-proven` even when all 0061/0062 rows are otherwise valid. Local verifier
tests are not substitutes for the missing Authority issuance receipt,
deployment-runner receipt, authenticated remote D1 readback, and independent
clean-host replay.

## Immutable Runner Release Evidence Overlay

Before any `ring-transition-control-plane-v1` item can authorize a staging
mutation campaign, it must reference a separate
`ring-transition-runner-release-v1` item. The latter is create-new and binds:

1. exact clean Git commit and tree plus source-archive digest;
2. `Cargo.lock`, `bun.lock`, and `package.json` digests;
3. Rust/LLVM/linker/Bun/Workerd versions, compilation target, arguments and a
   fixed build-environment allowlist;
4. sorted source/module inventory with relative path, byte count and SHA-256;
5. compiled launcher, final installed bundle and two-isolated-build digests;
6. non-circular compiled pins for fixed packet/policy names, release-policy
   digest, independent release-key SPKI digest and Authority origin, plus the
   DSSE manifest's exact account, ledger, services, policies, approval keys,
   Authority version, permit SPKI, trust-config and credential identities;
7. exact unit, Workerd, fault, configuration, security and no-secret test
   evidence against the same artifact digest;
8. release policy digest, issue/expiry times and independent Ed25519 release
   public-key SPKI fingerprint; and
9. canonical DSSE envelope/signature with no unknown or caller-selected
   manifest fields.

The release key must be distinct from transition, authorization, permit,
Authority-HMAC, read and deployment credentials. The verifier rejects dirty
or path-escaping inventory, an expired/future signature, differing repeated
builds, unknown fields, missing pins, environment/argv overrides, a mutable
checkout artifact, or an artifact not installed by its verified digest.

Execution evidence is a separate hash-chained receipt. It records only hashes
and allowlisted identities for credential preflight, claim/readback, each
persisted intent, one Controller POST, stable Controller reads, one Edge POST,
stable Edge reads and final claim state. Raw account/token/HMAC/private key,
authorization headers, Access material, bodies, SQL errors and unrestricted
Cloudflare metadata are forbidden. A lost/invalid/truncated POST response is
recorded as ambiguous and never authorizes resend.

The local offline verifier now enforces this canonical packet and detached
DSSE shape, and the clean-source collector derives commit/tree/archive/module
identities from committed Git objects. These are contract foundations, not a
release item: there is still no independently signed packet, isolated
two-build result, non-null compiled pin, installed executable, publication
receipt, or execution receipt. Rust-side fixed-sidecar, pin, DSSE,
current-executable and host-target verification now exists locally, but no
real release has satisfied it. P5 remains incomplete and production remains
**NO-GO**.

Every execution receipt must additionally prove that each Cloudflare POST was
enabled by a fresh same-process capability derived from an exact Authority
`step_appended` response. The capability binds authorization, claim, state
version, intent step, and canonical request digest; it is single-use and is
not issued for `step_replayed`, ambiguity, or restart recovery. The body must
bind the full authorization ID, state version, semantic intent digest, exact
service, and exact target before network I/O. Evidence that merely shows a
valid request shape or a persisted inflight row is insufficient.

## Rust Orchestrator Evidence Overlay

The local Rust runner now implements the pure snapshot and fresh-capability
boundary. This changes the required P5 evidence from "Rust implementation
absent" to "Rust integration and remote proof absent."

The `ring-transition-runner-release-v1` module inventory must contain
`crates/ring-transition-runner/src/orchestrator.rs` with its exact committed
byte length and SHA-256. The execution receipt must bind that release item and
add:

1. Authority snapshot byte digest, response byte count, Authority Worker
   version and the reconstructed final state version;
2. canonical claim digest plus ordered step/expiry digests, with no missing or
   duplicated version;
3. the reducer decision before every network boundary;
4. append request-ID digest and whether Authority returned fresh append,
   exact replay, conflict or outcome-unknown;
5. the persisted intent digest and exact canonical Cloudflare request digest
   consumed by the typed permit;
6. stable-read observation digests, timestamps, minimum gap, maximum pair age,
   deployment set, active version and version-detail digest;
7. process/restart generation and crash-point ID without serializing a permit;
8. deployment history readback proving lifetime POST count zero or one for the
   corresponding service; and
9. prior-receipt digest and final create-new receipt digest.

Raw snapshots need not be retained in P5 when they include provider-managed
metadata beyond the allowlist; retained evidence may be canonical digest-only
projections. The verifier must nevertheless recompute or independently attest
every digest from access-controlled source evidence. Raw credentials, HMAC,
private keys, Authorization/Access headers, deployment bodies, unrestricted
Cloudflare responses, SQL errors and customer/provider payloads remain
forbidden.

Local unit tests prove structure only: strict parsing, mixed-history rejection,
readback-only inflight resumption, fresh-versus-replayed append, request-digest
consumption and full Controller/Edge history. P5 remains incomplete until the
signed artifact's sole HTTP call site consumes the Rust authorized type and
remote Authority/D1/deployment history plus the crash matrix proves at most one
POST per service. Production remains **NO-GO**.

## Rust Release Verification Evidence Overlay

The release item must now retain enough data for an independent verifier to
replay every Rust authorization decision:

1. exact compiled enabled flag, fixed sidecar names, policy digest, release-key
   SPKI digest and Authority origin extracted from the installed executable;
2. raw canonical policy and packet byte digests plus bounded byte lengths;
3. independently recomputed DSSE PAE digest, signature result, key ID and SPKI
   digest without retaining a private key;
4. all 19 module records and their canonical inventory digest, including
   `orchestrator.rs`, `release.rs` and `publication.rs`;
5. signed target triple, launcher compile-time architecture/OS/ABI, executable
   file name, byte length and independently read back SHA-256;
6. pre-install symlink/hardlink/regular-file/canonical-parent results and the
   immutable destination generation identity;
7. verifier version, whole-second verification time, policy/release windows
   and result before any credential handle is opened; and
8. signed publication manifest/packet identities linking policy, packet,
   executable, generation, sequence and predecessor; and
9. exact create-new activation bytes linking publication manifest, outer
   packet, generation and predecessor.

The evidence must show the disabled/null checked-in build fails before clock
and file reads, while the real release build succeeds only for the reviewed
pins and exact compile target. A pure fixture or JavaScript consistency result
is not evidence that the installed Rust executable authorized itself.

Windows hardlink rejection is a mandatory pre-install evidence item because
the safe Rust runtime path does not claim NTFS link-count inspection. Unix
runtime evidence additionally requires link count one. Any missing receipt,
mixed generation, mutable active file, sidecar replacement, platform mismatch
or credential access before release success makes the release item invalid.

## Publication Activation Evidence Overlay

The local Rust core now defines the evidence shape that a real installation
must retain. This moves publication from "contract absent" to "ceremony and
external proof absent."

For every activation sequence retain:

1. canonical publication manifest, outer packet, payload type, key ID, DSSE
   PAE/signature result and whole-second verification time;
2. independently recomputed generation subject and exact artifact,
   release-packet and policy records;
3. publication-manifest-derived directory name and canonical installation
   root/`publications`/`activations` parent identities;
4. predecessor activation bytes and SHA-256 for sequence N >1;
5. create-new results for directory, four files and fixed sequence activation
   record, including service account and filesystem identity;
6. file sync, installed-byte readback and read-only/ACL results before
   activation;
7. exact activation-record bytes and digest after creation;
8. process/crash point and whether the generation remained unactivated; and
9. runtime readback proving credentials were unopened until the exact selected
   publication identity succeeded.

An unactivated directory is evidence, not an executable candidate. P5 must
inventory and quarantine it; automatic overwrite, deletion, adoption or
sequence reuse is forbidden. The real campaign must include two concurrent
installers, short/disk-full writes, permission failure, process kill after each
file/sync/freeze boundary, activation short write, predecessor drift and
power-loss durability.

The Rust core and deterministic JavaScript/Rust vectors are local evidence
only. P5 remains incomplete until a real release owner signs one candidate,
the operator-owned filesystem produces retained create-new/ACL/durability
evidence, and the exact installed launcher independently authorizes itself.

## 0068 Admission Evidence On The 0072 Schema Head

The frozen P5 candidate and schema-readback evidence now require Application
head `0072_relay_container_drain_source_authorization.sql`, 72 migrations,
99 required tables, 1611 checked incremental columns, and 148 key
indexes. The `admission-fence` item still requires the exact 0068 migration
name and pinned SQL digest. Placement-mutation authorization storage
provenance remains exactly 0063.

The operative P5 `admission-fence` item must bind:

1. environment-specific D1 identity and proof that no other environment shares
   the admission fence database;
2. normalized 0068 table/index/trigger inventory and historical backfill
   count/first/last/manifest readback, plus pre-apply cardinality and measured
   isolated-D1 migration duration;
3. exact Edge versions and every old/current admission writer in the drain
   inventory;
4. initial fence/head creation transaction, generation, admin identity,
   canonical request digest and exact readback;
5. stale Worker rejection with zero provider, Queue, billing, R2 publication,
   commit, receipt, reservation and operation deltas;
6. one successful same-batch commit/0050 receipt/financial/operation admission
   and independently recomputed commit digest;
7. the close race result, accepted high watermark/count/first/last keys,
   independently recomputed bookmark/member/page/complete manifests, and
   retained source schema/readback digests;
8. proof that no open operation is outside the commit ledger;
9. exact-current-head close+campaign atomic readback proving both mutations
   came from one SQLite command step and share the same D1 time;
10. N/N-1, process-loss and D1 response-loss results, plus proof that
    `recovery_required` and `aborted` cannot reopen admission under 0068; and
11. all five drain write gates false before any separately approved writer
    campaign.

Backfill evidence is accepted only when at least two rehearsals of the exact
row count complete in at most 25 seconds with a declared margin of at least
5 seconds under Cloudflare's current
[30-second D1 query and API batch ceiling](https://developers.cloudflare.com/d1/platform/limits/).

The offline assembler
`tools/collect_relay_container_p5_admission_fence.mjs` accepts one canonical
staging capture, recomputes the candidate digest, verifies the strict facts
shape, reads all 11 fixed supporting files without following symlinks or
allowing path escape, and emits evidence-v2 to standard output. The manifest-v3
verifier then binds admission facts to remote inventory, schema readback,
rollback evidence, and the common foundation capture. It rejects a close and
campaign whose D1 times differ and rejects approvals signed at or before the
latest evidence timestamp.

This assembler is deliberately offline: it reads no credentials, makes no
network request, mutates no remote state, and writes no file. It is not an
authenticated D1 collector or lifecycle writer. Locally seeded fence/head rows
and digest-only supporting projections are test fixtures, not promotion
evidence. Caller-supplied valid SHA-256 values are not accepted-set
completeness proof. The local 0070 one-statement command now exists, but a
remote capture still requires independent source recomputation, retained
provider readback, authenticated audited execution, and exact command/fence/
campaign readback. These remain production blockers.

The 0071 source-seal schema now requires a structural scan/member/page/shard
ledger before 0070 close, but it does not by itself upgrade caller digests
into trusted evidence. A valid P5 packet still needs an authenticated
`first-primary` D1 Session capture, independent canonical recomputation,
verified signatures and authorization receipt, retained raw/readback
artifacts, and remote late-admission/response-loss fault evidence.
No P5 item may infer traffic-return authorization from 0068, a drain campaign,
operation 14, or an eligibility receipt.

```powershell
bun tools/collect_relay_container_p5_admission_fence.mjs --describe
bun tools/collect_relay_container_p5_admission_fence.mjs `
  --capture .\evidence\admission-fence-capture.json `
  --bundle-root .
bun run check:relay-container:p5-evidence
bun run plan:relay-container:p5-evidence
```

The collect command emits canonical evidence JSON to standard output. The
operator must redirect it only into a create-new evidence location governed by
the external evidence-retention ceremony; the collector itself never chooses
or overwrites a destination.
