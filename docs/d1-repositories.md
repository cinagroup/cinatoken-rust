# Worker D1 Repositories

The Worker crate now keeps Cloudflare D1 SQL behind `crates/worker/src/d1_repositories.rs`.

This module owns Worker-specific storage operations:

- token and user authentication row lookup;
- best-effort token status updates for expired or exhausted tokens;
- OpenAI-compatible channel selection from `abilities` first, then channel CSV fallback;
- billing option lookup for Go-compatible `billing_setting.*` maps and group
  ratio maps;
- cached-auth quota-state refresh before validation;
- tiered-expression quota reserve, refund, and settlement mutation for user,
  token, and channel counters with compensation on later-step failures;
- token access-time updates;
- user request-count increments;
- relay audit log insertion;
- stable-cursor discovery of open Realtime usage reconciliations;
- revision-fenced, idempotent Realtime reconciliation settlement/refund batches
  that retain quarantine provenance and write financial plus root audit state
  atomically;
- generation-fenced Container reconciliation status/list reads and observer
  lifecycle mutations;
- the default-off 0045 Container observer retry event, exact dead-letter
  readback, and event-plus-admin-audit D1 batch. The repository contains no
  direct operation, billing, user, token, channel, DO, provider, or R2 mutation
  for this command; the observer transition is owned by the migration trigger;
  and
- a future Container operation schema-readiness helper for the trigger-only
  0046 enforcement boundary. The helper requires the 0040/0041/0042/0046
  migration records and all four identity, initial-state, terminal
  event/outbox, and recovery-predecessor trigger names. It is compiled and
  source-tested but has no production call site yet; every Container operation
  path remains default-off and unwired, so this helper is not an active runtime
  gate;
- a migration-0048 provider-usage schema-readiness helper requiring both
  receipt and identity tables, their six immutable guards, the terminal linkage
  guard, and the operation-completion guard; and
- exact immutable provider-receipt lookup plus flat/tiered settlement
  verification from the frozen reservation snapshot. The repository rejects
  missing priced usage fields, derives flat total from prompt plus completion,
  and binds the resulting financial terminal event to receipt/result hashes,
  attempt generation, and provider/client status.

`relay.rs` remains responsible for request parsing, auth validation policy,
cache orchestration, upstream forwarding, and audit payload construction. D1
remains the source of truth; Upstash Redis read-through cache is an acceleration
layer only.

Keeping this boundary inside the Worker crate avoids making pure Rust crates
depend on Cloudflare Worker runtime types while still removing raw SQL from the
relay control flow. If a non-Worker runtime is added later, it can implement the
same repository-shaped operations without changing relay orchestration.

The reconciliation HTTP module passes typed mutation and audit values into the
repository. It does not construct D1 prepared statements. Frozen billing
expression snapshots remain the only pricing input, and the default-off runtime
gate is enforced above this repository boundary.

Migration 0046 does not add a pricing lookup, recalculate a billing expression,
or repair financial rows. The financial writer still owns one ordered D1 batch
for immutable event, outbox, operation, billing, and accounting statements, and
settlement must continue from the frozen reservation snapshot. The separate
read-only enforcement audit binds aggregate D1 preconditions to a signed
deployment-inventory hash; it does not grant mutation authority or replace
remote version and trigger-SQL readback.

Migration 0047 adds a separate provider-egress schema-readiness helper. It
requires the 0047 ledger row plus the immutable grant table and its insert,
update, and delete trigger names. It does not replace the 0046 helper: 0046
proves historical financial-terminal enforcement, while 0047 proves the later
pre-send provenance schema.

New tiered reservation writes are no longer allowed to carry an empty snapshot.
The repository parses the canonical serving-group map, validates every durable
`TieredBillingSnapshot`, binds its expression hash to the reservation contract,
requires byte-for-byte equality with its own canonical reserialization, and
rejects cross-group differences in model, expression/version, request facts,
evaluation instant, QuotaPerUnit, estimate, or tier. The frozen instant must be
a non-negative Unix second representable through year 9999. The relay owns
request projection and serialization; D1 owns immutable storage. Historical
empty rows remain readable for quarantine and migration accounting and are not
silently upgraded.

## Migration 0048 Provider Usage Receipt Boundary

Migration 0048 adds D1 authority after the provider body and R2 result exist.
The Controller remains the only receipt writer. It performs a pre-send schema
read through a `first-primary` session; after provider completion it writes the
result to R2 with create-only semantics, then runs one D1
`INSERT OR IGNORE` and reads the row back through the same session. The Worker
repository is the terminal consumer: it does not reconstruct a receipt from a
public response or trust Controller-computed quota.

The canonical v1 JSON is limited to 8,192 UTF-8 bytes and has exactly 38 fields
in declaration/wire order:

```text
schema_version, parser_contract, normalization_contract, source, estimated,
operation_id, owner_generation, attempt_generation, provider_operation_id,
request_sha256, egress_profile, egress_worker_version_id,
provider_response_status, provider_response_sha256, provider_request_id,
provider_completed_at, usage_present, reported_usage_fields, prompt_tokens,
completion_tokens, total_tokens, cached_tokens, cache_creation_tokens,
cache_creation_tokens_5m, cache_creation_tokens_1h, image_input_tokens,
image_output_tokens, audio_input_tokens, audio_output_tokens,
is_anthropic_usage_semantic, usage_semantic_source, provider_cost_usd,
cache_creation_source, responses_web_search_calls,
responses_file_search_calls, claude_web_search_calls,
image_generation_quality, image_generation_size
```

The repository requires schema 1, parser
`openai-chat-completions-usage-v1`, normalization
`billing-token-normalization-v1`, source `provider_response`,
`estimated=false`, and egress profile
`openai-chat-completions-canary-v1`. It reserializes the parsed object and
requires byte equality, recomputes SHA-256, validates every identity/result
column against the JSON, and rejects extra or missing fields. The private
base64url header is bounded separately to 12,288 bytes; D1 stores canonical
JSON and its lowercase digest, not the encoded transport form.

`reported_usage_fields` has only these valid bits: 0 prompt, 1 completion,
2 total, 3 cached, 4 aggregate cache creation, 5 five-minute cache creation,
6 one-hour cache creation, 7 image input, 8 image output, 9 audio input, and
10 audio output. Its maximum is 2047. Missing normalized values are zero with
their bit clear; a reported zero keeps its bit. `usage_present` is true exactly
when bits 0 and 1 are both set. The provider-total bit is optional: flat
settlement computes a checked `prompt_tokens + completion_tokens`, so an absent
provider `total_tokens` cannot turn valid usage into zero or become an alternate
amount authority.

Required-field validation is derived from the frozen price contract. Tiered
expressions require the corresponding `cr`, `cc`, Anthropic `cc1h`, `img`,
`img_o`, `ai`, and `ao` mask bits; Anthropic `len` also requires cached and both
split cache-creation bits. Flat per-token snapshots require cached/cache-
creation/image/audio bits whenever the selected ratios or audio mode price
those categories. A missing priced bit rejects. Fixed-price token categories
do not invent mask requirements, while tiered tool/image-generation settlement
remains unversioned and rejects. Non-finite or negative tiered intermediates,
unknown bits, nonzero values with a clear bit, and arithmetic overflow all fail
closed.

The receipt table is append-only and has a separate
`relay_container_provider_usage_receipt_identities` ledger for the
operation/owner/attempt, provider-operation, and R2 key/version identities.
Receipt and identity updates/deletes are forbidden. The receipt's `AFTER
INSERT` identity guard means `INSERT OR REPLACE` also aborts when
`recursive_triggers=OFF`: SQLite may implicitly delete the receipt row, but it
does not remove the separate identity row. Exact replay is therefore only
`INSERT OR IGNORE` followed by complete readback.

For settlement, the repository requires a canonical actual receipt with
prompt/completion present, provider status other than 202, exact attempt 1,
and exact receipt/result hashes. It recomputes quota from the frozen tiered or
flat snapshot and prepares an event carrying the receipt linkage. D1 then
requires the terminal event's client status and the completed operation status
to equal the receipt provider status. A status-202 receipt may remain immutable
evidence, but cannot complete or settle. Refund and `recovery_required` paths
must carry no provider linkage.

This boundary still is not independent D1 amount authority. Arbitrary billing
expressions execute in the Worker before the D1 batch; database triggers attest
linkage and ordering, not expression semantics or the final amount. The shard
DO currently records only the R2 result manifest and does not store/compare the
receipt hash, and the reconciliation path does not yet compare receipt identity
across R2, D1, DO, terminal event, and provider invoice. Those are production
NO-GO items, along with the absent production terminal caller,
provider-native idempotency/lookup, and the post-provider/pre-R2 ambiguity.

A true 0047 settle writer is deliberately incompatible with schema 0048 because
it omits receipt linkage. Apply 0048 only after all such writers and in-flight
provider work are drained or quarantined with every gate false. Rollback is
disable-first and retains schema, rows, triggers, R2 evidence, and migration
history; a rolled-back 0047 artifact must have no provider traffic. No remote
schema, deployment, binding, or secret action is implied by this repository
contract. Go/VPS remains authoritative and production remains **NO-GO**.

## Migration 0049 Four-Store Binding Repository Boundary

Migration 0049 makes the D1 repository the persistence boundary for observed
provider-usage convergence without pretending that D1 can read R2 or a Durable
Object. The repository first reads and validates the immutable 0048 receipt
identity and its exact terminal event. The observer separately proves DO status
v3 and R2 metadata v4; only then may it pass the verified tuple into the D1
transition.

`RelayContainerReconciliationRecord::Converged` now optionally carries the
verified provider tuple. For a receipt-backed operation it must contain attempt
1, the canonical receipt digest, and canonical result digest. The repository
updates the leased observation to `converged` and writes canonical, DO, R2, and
terminal receipt evidence in the same D1 statement. Migration triggers compare
canonical fields to the immutable 0048 receipt and terminal event, require all
three external/local evidence digests to equal the canonical digest, and freeze
the row after matching.

The repository cannot use a null provider tuple to bypass this rule. A legacy
no-receipt observation may still converge as `not_applicable`; if a canonical
0048 receipt exists, the 0049 convergence trigger rejects an old or incomplete
writer. Retry and dead-letter records do not manufacture binding evidence and
preserve the 0045 lifecycle.

Schema readiness now requires 0049 and its exact observation columns and
guards. It first composes the full 0047/0048 provider-egress readiness check,
then verifies the 0049 binding index and the rebuilt lifecycle trigger still
contains the 0045 retry-event state machine. This is intentionally asymmetric
rolling compatibility: old observers
may read, retry, or dead-letter, but cannot converge receipt-backed work. Apply
0049 only with reconciliation disabled and old owners drained/read back. Normal
rollback keeps 0049 and all evidence, disables provider/terminal/reconciliation
first, and uses an artifact that will not exercise an incompatible writer.

Controller receipt idempotency is read-first in one `first-primary` session.
An exact existing row returns without issuing `INSERT`; only an absent row
reaches `INSERT OR IGNORE` and complete readback. This distinction is required
after convergence: 0049 intentionally blocks every late receipt INSERT,
including an identical one, so stale writers cannot reopen terminal evidence.

This boundary proves local R2/D1/DO/terminal agreement only. Provider invoice,
arbitrary billing-expression and final-amount authority, remote staging
evidence, and production terminal operation remain outside this repository and
keep production **NO-GO**.

## Migration 0069 Traffic-Return Evidence Read Boundary

The Worker repository adds a deliberately read-only boundary for
`0069_relay_container_traffic_return_evidence_enforce.sql`.

`relay_container_traffic_return_evidence_schema_ready()` requires the exact
0069 marker, ordered columns for the subject/item/seal tables, all three table
names, four explicit indexes, nine immutable table triggers, and the rebuilt
0067 receipt guard. The receipt-guard probe also checks that the active trigger
joins subject and seal records, resolves typed Go/VPS, finance and WORM
evidence, enforces review/retention time, and checks issuer independence.

`relay_container_traffic_return_evidence_by_campaign()` accepts only a
lowercase SHA-256 campaign identity and inner-joins one subject to one seal.
It validates contract versions/names, migration identity, environment/scope,
fence generation, every returned digest, the 300-second to 24-hour review
window, subject/seal retention, eight-item seal count, evidence-custodian
role, seal chronology, and expiry against D1 `unixepoch()`.

The repository exposes no subject, item, seal, or traffic-return receipt
mutation method. Signature/policy verification and authenticated writer
authority remain a future boundary. Applying 0069 therefore makes an
incompatible or incomplete schema fail closed without enabling traffic or
creating evidence. All five drain write gates remain false, Go/VPS remains
authoritative, and production remains **NO-GO**.

## Migration 0070 Atomic Drain Close Command Boundary

Migration `0070_relay_container_drain_close_command.sql` advances the local
Application head to 70 migrations, 92 required tables, 1463 checked
incremental columns, and 137 key indexes. The repository's
`relay_container_drain_close_command_schema_ready()` probe requires the exact
0070 marker, ordered 39-column command table, four indexes, six trigger names,
and critical trigger-body guards for the complete 0067-0070 chain,
command-only fence closure, command-only campaign creation, and one-statement
application.

`relay_container_drain_close_command()` is strict readback. It validates the
full command row and its joined closed fence and created campaign rather than
treating insertion success as completion.
`apply_relay_container_drain_close_command()` is present only as a
default-inert repository boundary. Its signature requires the caller to
supply an admin-audit `D1PreparedStatement`; a fresh apply executes:

```text
db.batch([command INSERT, admin audit, exact joined readback])
```

The 0070 `AFTER INSERT` trigger performs the actual fence close and campaign
creation within the command statement. The repository then strongly checks
the joined readback against every requested command field. Conflicting
identity reuse fails closed; exact prior state is classified without
reapplying the close.

No HTTP route, Cloudflare credential, runtime write gate, or production call
site invokes this method. The platform capability is schema readiness only.
Consequently, adding the repository mutation does not grant operator or
traffic authority.

The 0068 migration identity and SHA-256 provenance remain unchanged, including
the pinned digest
`fa8b6a9639ef803d367a0be3013c62e9c5bc47861a1bb38c18085fde5e1dca50`.
The accepted bookmark, manifest, source schema, and source readback supplied
to 0070 remain caller-attested pending independent authoritative-source
recomputation. The boundary does not evaluate or modify billing expressions,
quota conversion, or settlement.

Local Workerd verifies a nonempty accepted set and late-admission rejection;
the SQLite verifier proves downstream campaign failure rolls back the command
and fence together. No remote D1/Cloudflare state was accessed or changed.
Go/VPS remains authoritative and production remains **NO-GO**.

## Migration 0071 Accepted-Source Seal Read Boundary

Migration
`0071_relay_container_drain_accepted_set_source_seal.sql` advances the local
Application head to 71 migrations, 97 required tables, 1550 checked
incremental columns, and 144 key indexes.

`relay_container_drain_source_seal_schema_ready()` is an exact fail-closed
probe for:

- the 0071 migration marker;
- ordered scan/member/page/shard/seal columns;
- exactly five source table names and seven explicit indexes;
- all 15 source-table immutable/order/completeness trigger names plus the
  0070 close source-seal guard; and
- critical trigger SQL for complete migration markers, current open
  fence/head binding, full membership before page/shard inventory, fixed
  bookmark/pagination contracts, pinned 0068 schema identity, and the final
  close-time source recheck; and
- explicit primary/unique conflict rejection in every source insert guard, so
  `INSERT OR REPLACE` cannot bypass append preservation through an implicit
  delete.

`relay_container_drain_accepted_set_source_readback()` accepts only a
lowercase SHA-256 seal identity and returns one sealed aggregate in strict
accepted-sequence, page-ordinal, and shard-index order. It rejects malformed
contracts, bounds, operation identities, page chains, missing or reordered
members, incomplete shard coverage, stale first/last identities, digest
drift, non-independent roles, source-schema drift, and any mismatch among the
accepted-set, shard-set, retained-readback, or seal digests.

The pure canonical helpers use length-prefixed bytes and big-endian integers
for admission-member, page, shard, shard-set, accepted-set, exact-readback and
seal SHA-256 contracts. Historical pre-0068 members retain their original
atomic-admission digest; fenced members recompute the existing admission
commit v1 domain. The repository validates these values on read rather than
trusting syntactically valid hashes.

There is deliberately no source scan/member/page/shard/seal mutation method,
HTTP route, credential, or runtime write gate. Platform capability exposure
is the single schema-readiness boolean only. The current code also does not
claim that D1 itself verified an external signature: assembler/verifier
identity and signature-envelope fields become trusted only after a future
authenticated collector verifies managed keys and records a typed
authorization/audit receipt.

The future writer must remain in the root Application Worker that owns the D1
binding, use a real `first-primary` D1 Session with bounded keyset pagination,
and classify ambiguous mutation responses through stable readback. A
service-bound controller may orchestrate but must not gain an independent D1
or bypass authentication. Go/VPS remains authoritative and production remains
**NO-GO**.
