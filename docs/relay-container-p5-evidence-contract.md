# Relay Container P5 Evidence Contract

Date: 2026-07-19

Status: local, credential-free, campaign-aware evidence-verifier candidate. It authorizes no
remote mutation, customer traffic, production cutover, or Go/VPS shutdown.

Current baseline: migration head
`0055_relay_container_shard_activation_campaigns.sql`, migration count 55, and the
locally verified schema shape of 62 tables, 771 incremental columns, and 91
key indexes. This 0055/55 baseline supersedes every historical 0054/54
reference retained below. Nothing in this document claims that 0055 was
applied, deployed, or read back from Cloudflare.

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
complete pagination result. Its fixed 13-command Wrangler allowlist performs
only exact Worker version/deployment, D1, R2, KV, and Container readback. It
emits digests and status metadata rather than raw control-plane output.

The current Wrangler list commands do not expose enough cursor state for this
collector to prove that every page was traversed. Every deployments, KV, and
Container list command is therefore classified as `unverifiable-list`, emits
`paginationComplete=false`, and remains `not-proven` even when its first page
is shorter than the requested limit. Foundation and P5 remain **NO-GO** until
a later control-plane reader explicitly traverses every page and proves a
terminal cursor. Item count and page size are not substitutes for that work.

Cloudflare Container instance inventory cannot prove sleeping Durable Object
members. The collector therefore requires a stable app-owned shard activation
ledger plus separate action-gate, SBOM/signature/provenance, R2 writer/object,
and traffic-isolation sources. The shard source embeds the canonical capture
under foundation sources v2 and binds its recomputed
`sourceArtifactSha256`. Missing or incomplete sources produce explicit
blockers and `paginationComplete=false`; they can never be converted into a
P5 pass by elapsed time. The complete contracts and live SOP are in
`docs/relay-container-p5-foundation-collector.md` and
`docs/relay-container-shard-activation-ledger.md`.

## Manifest Identity

The operative manifest is schema version 2 with contract
`cinatoken-relay-container-p5-promotion-manifest-v2`. Version 2 adds the
required canonical foundation capture artifact record; a version-1 manifest
cannot be upgraded by inserting an optional field and is rejected.

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
- D1 head 0054 and count 54;
- response protocol 3, status contract 4, financial terminal contract 2, and
  terminal ACK contract 3;
- a bounded, non-streaming, synthetic `/v1/chat/completions` cohort with no
  customer traffic; and
- the fixed `evidence/foundation-capture.json` path, byte length, and complete
  file SHA-256 digest; and
- the path, byte length, SHA-256 digest, capture time, and expiry of every
  evidence file.

The subject digest is SHA-256 over canonical subject JSON. Evidence files bind
the same candidate digest. A packet cannot mix schema evidence from one commit,
lifecycle evidence from another image, and approval from a third deployment.

## Required Evidence

All ten kinds are required exactly once and in contract order:

| Kind | Required proof |
| --- | --- |
| `candidate-freeze` | Exact commit/version/image/runtime-build/provenance/SBOM inventory, image signature and runtime-to-image provenance verified, zero unapproved critical/high vulnerabilities, every action gate false |
| `remote-inventory` | Account digest, exact shared D1/KV/R2 identities, Controller/egress services, DO namespace/binding/class, candidate runtime build and image provenance, all shards accounted for, zero unknown writers/objects/customer traffic |
| `reader-first-rollout` | Egress before Controller, Controller before edge, readers before writers, every shard on a compatible reader, no new response write, public `/internal` 404, N/N-1 or blue/green skew proof |
| `schema-readback` | Remote 0055/55 and exact 62-table/771-column/91-index baseline, normalized schema digest, unchanged business fingerprint, old-writer and direct-negative probes with zero provider/financial delta |
| `lifecycle-fault-campaign` | Cold/warm start, DO eviction, Container sleep/restart/OOM, duplicate alarm, callback failure, malformed/future payload, N-1, and response loss; zero duplicate provider/financial effects |
| `response-financial-fault-campaign` | Success, typed error, HTTP error, invalid body, and recovery; every D1 statement fault; response-class totals equal provider operations, one provider operation per send, settled plus refunded terminal conservation, zero request accounting on refund, exact client replay and classified R2 orphans |
| `cross-layer-provenance` | Complete redacted edge/Controller/DO/Container/broker/provider/D1/R2/financial/audit/client tuple with no identity gap or payload/credential leak |
| `load-cost-slo` | At least one hour and 1,000 requests, Rust 5xx delta at most 50 basis points, non-stream p95 overhead at most 300 ms, zero D1/resource errors, delivered alert drills, approved 1x/2x/5x cost |
| `rollback-rehearsal` | Gates disabled first and read back false, all in-flight work classified, zero new Rust admission/resend/duplicate finance, Go authority restored, P3 readers/0054/evidence retained, rollback within 15 minutes |
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
   0054 then 0055 after the already ordered 0052/0053 reader chain, and verify the exact
   0055/55 and 62/771/91 baseline with immutable negatives and unchanged
   business fingerprints.
4. Upload a disabled provider-egress version, then a Controller reader, then an
   edge reader with the private Service Binding. Activation recording remains
   false and the Controller accepts both legacy and build-bearing readiness.
5. Roll the Container candidate at 10% and 100%. At each stage read back the
   exact image, compatible runtime protocol/build, zero customer traffic, and
   zero provider/financial delta.
6. Create one root-authorized same-Controller-version activation campaign and
   use its one-time nonce without changing any static gate. D1 must claim each
   shard before DO lookup; completed claims use replay-only journal reads; only
   a `sealed_complete` N/N campaign can continue.
7. After that campaign is sealed and every effective action gate is false,
   capture the root-only campaign receipts and activation ledger before and
   after 300-7200 seconds using the first page's frozen high watermark and
   complete keyset traversal. Receipts and 0054 rows must match one-to-one,
   rows must be fresh for this campaign, activation generation must be one,
   and sources-v3 action-gate, SBOM/provenance, R2, traffic-isolation, and
   control-plane facts must overlap the same window.
8. Implement and archive explicit full pagination for every Cloudflare
   control-plane list. Until that reader exists, foundation and P5 remain
   `not-proven` regardless of the activation ledger result.
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

On the current worktree, the focused 0055 checks pass the 55-migration
62/771/91 SQLite verifier, 44 P5 verifier tests, 16 foundation collector tests
plus its offline self-test, 13 shard-registry/campaign collector tests, and 22 deploy-preflight
tests. These are still local contract checks, not Cloudflare evidence.

Those fixtures are tests of the verifier, not Cloudflare evidence. No remote
resource, credential, provider, financial row, deployment, or traffic state was
changed. Production remains **NO-GO**.
