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

## Local Commands

```powershell
bun run check:relay-container:p5-foundation
bun run plan:relay-container:p5-foundation -- --request C:\secure-evidence\p5\foundation-request.json
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
- migration `0053_relay_container_financial_terminal_v2.sql`, count 53;
- response/status/financial-terminal/terminal-ACK contracts 3/4/2/3.

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
unexpected stderr, missing identity, or full 100-item Container page becomes a
fail-closed blocker.

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
evidence contract, root package/lock files, and the installed Wrangler package,
launcher, and executable CLI bundle. Any tool or pinned Wrangler artifact drift
blocks foundation readiness.

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
cinatoken-relay-container-p5-foundation-sources-v1
```

The bundle is candidate-bound, account-bound, captured inside the observation
window, pagination-complete, and contains these five independently identified
source summaries:

| Source | Required proof |
| --- | --- |
| `actionGates` | every admission, execution, writer, retry, recovery, and wake gate is false |
| `sbom` | exact image digest and SBOM digest, verified signature, zero unapproved critical/high findings |
| `shardRegistry` | stable app-owned DO namespace/activation ledger, exact ring generation, N/N verified shards |
| `r2Inventory` | complete writer/object inventory with zero unknown writers and zero unknown objects |
| `traffic` | zero customer traffic and verified staging isolation |

Each source carries `status`, `collectorId`, `collectorVersion`, and
`sourceArtifactSha256`. `unknown` and `fail` are representable but always block
foundation readiness. Omitting the bundle yields explicit blockers for all five
sources and sets `binding.paginationComplete=false`.

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

## Fail-Closed Meaning

Foundation readiness is blocked by any absent source, partial page, candidate
identity miss, before/after drift, collector drift, nonempty Wrangler stderr,
unknown R2 writer/object, incomplete shard registry, customer traffic,
unverified isolation, action gate, SBOM/signature issue, or source timestamp
outside the observation window.

Passing local tests proves only the collector contract and redaction boundary.
No authenticated readback was run in this implementation increment, no remote
resource changed, and production remains **NO-GO**.
