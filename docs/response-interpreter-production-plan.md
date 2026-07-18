# Production Response Interpreter And Durable Artifact Plan

## Status And Safety Boundary

This document freezes the production design for response interpretation across
the Worker and Container execution planes. It does not authorize a deployment,
schema apply, secret mutation, provider call, financial mutation, or traffic
change. Go/VPS remains authoritative and production remains **NO-GO**.

The source authority for response semantics is the clean Go checkout at commit
`73652508abc5cb09214dde02d51d69d1d1ccc703`. A candidate built against another
commit must regenerate and review the differential corpus before promotion.

The local Rust foundation uses the versioned contract
`go-openai-response-v1`. It is a pure bounded-body interpreter in
`crates/relay`; transport deadlines, retries, persistence, billing, and client
delivery remain explicit caller responsibilities.

## Frozen V1 Semantics

| Input | Interpretation | Client status | Usage authority | Provider headers |
| --- | --- | --- | --- | --- |
| HTTP 200, JSON object, no typed error | ordinary success | 200 | parsed from the selected profile | success allowlist only |
| HTTP 200, typed top-level `error` | typed error | 200 | none | none |
| HTTP 200, malformed, empty, scalar, or array JSON | bad response body | 500 | none | none |
| Any non-200 status | status error | original status | none | none |
| Stream transport interruption after usage | interrupted observation | existing stream status | retain observed usage | success stream policy only |

The dynamic HTTP-200 error rule follows the Go DTO behavior:

1. `error: null` is absent.
2. An error object is typed only when its string `type` is non-empty.
3. A string error becomes type `error` with that string as the message.
4. Another JSON value becomes type `unknown_error`.
5. An object containing only `message` and no type is not a typed error.

For non-200 bodies, a valid OpenAI error object with a non-empty message keeps
its message, type, parameter, dynamic code, and metadata. Otherwise message
precedence is `error`, `message`, `msg`, `err`, `error_msg`, `detail`,
`header.message`, then `response.error.message`. Invalid bodies become
`bad response status code <status>`.

The success response-header allowlist is exactly:

- `content-type`
- `content-language`
- `retry-after`
- `x-request-id`
- `request-id`
- `openai-request-id`

Header names are case-insensitive. `set-cookie`, authentication headers,
hop-by-hop headers, provider cache policy, `content-length`, and every
unrecognized header are excluded. Error responses are rebuilt locally with
local content type, CORS, and cache policy only.

## Shared Interpreter ABI

The shared module accepts only bounded bytes, an upstream status, and an
explicit provider usage profile. It returns immutable facts:

- upstream and client status;
- success, typed-error, status-error, or invalid-body classification;
- normalized OpenAI-compatible error fields;
- parsed usage for successful bodies only;
- exact raw body SHA-256;
- parsed JSON object when valid; and
- a separate audit status so an HTTP-200 typed error cannot enter success
  settlement.

The ABI contains no `worker::Response`, Hyper, Axum, D1, R2, Durable Object, or
billing type. This prevents transport behavior from changing the semantic
contract and lets the same immutable corpus exercise every caller.

Provider-specific response transforms may run around this ABI, but they must
not weaken the exact-200 gate or independently parse the same error semantics.
Any new provider profile requires source evidence and corpus cases.

## Execution-Plane Wiring

### Worker

The Worker applies status-only retry selection before the final response is
chosen. After a final bounded response is selected:

1. A requested stream enters stream processing only when the HTTP status is
   exactly 200. A non-200 stream request is buffered and interpreted as an
   error.
2. A non-streaming JSON response is interpreted before usage settlement or
   response headers are committed.
3. Ordinary success supplies usage to existing provider-specific estimation
   and settlement logic.
4. Typed HTTP-200 errors retain client status 200 but use error audit status,
   zero usage, and no provider headers.
5. Non-200 and invalid bodies return the normalized error envelope and cannot
   inherit provider headers.
6. Existing `SseUsageAccumulator` evidence survives a stream read error. The
   terminal fault is recorded independently from the usage observation.

### Container

The first trusted component to receive raw provider bytes is
`cinatoken-container-egress`. The Linux runtime receives only a Controller
outcome and must not link the relay parser.

The disabled v2 Container path applies the interpreter immediately after its
deadline-bounded response read. Only ordinary exact-200 success may emit a
provider usage receipt. Every other interpretation emits no usage receipt and
therefore cannot be terminalized as success by the current Controller.

This is a fail-closed bridge, not production response parity. The current
Controller maps such responses to recovery/ambiguity because the durable
schema cannot yet distinguish raw provider evidence from a rebuilt client
artifact. Canary activation remains forbidden until the v3 evidence protocol
below is implemented and verified.

## Why Receipt V1 Must Stay Frozen

Migration 0048 intentionally binds a successful provider response, its R2
result, and normalized usage:

- provider status is constrained to 200 through 299 in historical receipt
  validation;
- `provider_response_sha256` equals `result_sha256`;
- a result object and receipt are mandatory for a succeeded attempt; and
- a definite reject cannot carry a result or usage receipt.

Those rules cannot represent a provider non-200 body, an HTTP-200 typed error,
or a rebuilt error envelope without conflating evidence and client behavior.
Receipt v1 remains readable and immutable. New response evidence uses a new
contract and does not reinterpret historical rows.

## Durable Response Artifact V2

### Two Immutable Artifacts

Every completed provider HTTP response must create two logically separate
records before terminalization:

1. **Raw provider evidence** records the exact provider status, bounded body,
   approved observed headers, request ID, provider completion time, body hash,
   and egress identity. It is never returned directly as an interpreted error.
2. **Client response artifact** records the interpreter contract, class,
   client status, canonical body, approved client headers, body/header hashes,
   and the raw evidence digest from which it was derived.

Exact-200 ordinary success may have byte-identical raw and client bodies, but
the records and object namespaces remain distinct. Equality is an audited
fact, not an implicit identity. Error artifacts always contain the rebuilt
canonical envelope.

### R2 Namespaces

- Raw body:
  `container-provider-evidence/v1/<operation>/<owner>/<attempt>/<raw-sha256>`
- Client body:
  `container-client-artifacts/v1/<operation>/<owner>/<artifact-sha256>`

Both writes are create-only with exact replay by object version and digest.
Neither namespace permits overwrite or delete on the request path. Retention,
legal hold, export, and eventual deletion require a separately approved
operator workflow.

### Migration 0052 Plan

The next available D1 migration is reserved as
`0052_relay_container_provider_response_artifacts.sql`. The earlier alarm
bridge correctly required no 0052; this response-evidence migration is a new
and unrelated ownership boundary.

The migration adds two append-only tables and identity ledgers.

`relay_container_provider_response_evidence` freezes:

- operation, reservation, owner, and attempt identity;
- provider operation, admission, request, channel, group, model, and endpoint;
- egress profile and exact Worker version;
- raw status from 100 through 599;
- raw content type, approved canonical header JSON and SHA-256;
- raw R2 key, version, SHA-256, and size;
- provider request ID and completion time; and
- interpreter source commit and response contract.

`relay_container_client_response_artifacts` freezes:

- operation, owner, attempt, and raw evidence digest;
- interpreter contract and classification;
- client status from 100 through 599, including typed-error status 200;
- canonical approved header JSON and SHA-256;
- client R2 key, version, SHA-256, and size; and
- creation time and exact replay identity.

Required guards include:

1. insert-only rows plus separate identity ledgers to defeat SQLite `REPLACE`;
2. exact foreign keys to admission and egress grant identity;
3. canonical JSON field-count, key, type, size, and digest validation;
4. status/class relationships, including success only at 200;
5. success-only optional reference to a 0048 usage receipt;
6. typed/status/invalid error rows forbidding usage receipts;
7. client artifact creation only after matching raw evidence;
8. terminal event creation only after matching client artifact; and
9. old-writer guards that prevent a mixed 0051/0052 deployment from claiming
   converged success.

Migration preflight must verify every table, index, trigger, normalized SQL
fingerprint, column, and negative mutation before provider dispatch. Remote
apply requires account/name/UUID binding, old-writer drain, backup/export,
named rollback ownership, and readback from the deployed artifact.

## Container Protocol V3

The egress Service Binding protocol must carry both bounded artifacts without
placing large bodies in headers. Protocol v3 should use one strict canonical
envelope with explicit lengths and SHA-256 values. It may omit duplicate client
bytes only when the envelope asserts `client_body_same_as_raw=true` and both
hashes match.

The Controller must treat v2 and v3 as different protocols:

- v2 remains readable for disabled recovery only and cannot enter canary;
- v3 is exact-version fenced until an N/N-1 range is proved;
- unknown fields, order drift, duplicate keys, invalid base64, invalid UTF-8,
  oversized bodies, digest mismatch, or missing interpretation fail closed;
- synthetic broker failures never masquerade as completed provider evidence;
  and
- TypeScript verifies the Rust attestation but does not reinterpret provider
  response semantics.

The DO-local schema requires a new migration and provider-attempt terminal
shape. Provider status and client status become separate fields. A new
interpreted-reject terminal can carry a client artifact with client status 200
or non-200 while carrying no successful result/usage receipt. Retry policy uses
the raw provider classification, never the rebuilt client status.

The Linux runtime outcome protocol gains an explicit rejected outcome. It
continues to receive no raw provider headers, credential, or provider body and
must reject provider 202 as success.

## Billing And Usage Invariants

1. Only ordinary exact-200 success can create a provider usage receipt or enter
   success settlement.
2. A typed error at HTTP 200 retains client status 200 but uses error audit and
   refund/terminal policy.
3. A non-200 body never contributes usage even if it contains a `usage` field.
4. Stream transport failure does not erase usage already observed in valid SSE
   events.
5. Application-level stream failure and transport interruption remain distinct
   facts; provider-specific behavior must be source-pinned.
6. Missing usage estimation remains caller policy and cannot turn an error
   interpretation into success.
7. Settlement and response artifact creation are idempotent, generation-fenced,
   and linked in one financial terminal decision.

No billing expression semantics change in this packet. Any later expression
change requires a fresh source-authority review before implementation.

## Differential Corpus

The immutable Go/Rust corpus must contain at least:

- 200, 201, 202, 204, 206, 3xx, 400, 401, 408, 409, 425, 429, 500, 504, and 524;
- typed HTTP-200 object, string, scalar, null, and message-only error fields;
- OpenAI error objects plus every general-message fallback field;
- empty, malformed, scalar, array, oversized, and invalid-UTF-8 bodies;
- success and error header projections, mixed casing, repeated values, unsafe
  request IDs, forbidden cookies/authentication/hop-by-hop headers;
- complete, missing, partial, and invalid usage;
- LF, CRLF, split SSE fields, `[DONE]`, bare EOF, timeout, client loss, and
  usage observed before terminal stream error; and
- exact raw body, interpreted body, header, and manifest hashes.

The manifest records repository, full Go commit, authoritative source hashes,
generator and injected-template hashes, unique case names, exact case counts,
and a canonical manifest digest. Generation refuses tracked Go changes and
cleans temporary test files even on failure. Rust replays every case; thin
Worker and Container adapter tests prove they call the shared ABI without
changing its result.

## Promotion Gates

All gates are conjunctive.

| Gate | Required evidence | Abort condition |
| --- | --- | --- |
| R0 source freeze | Clean pinned Go commit, source hashes, regenerated corpus | source or manifest drift |
| R1 shared ABI | Native and wasm tests for all buffered classifications and stream usage retention | caller-specific semantic branch |
| R2 header boundary | Exact six-header success allowlist and zero provider error headers | any forbidden header emitted |
| R3 migration 0052 | Local SQLite negatives, remote apply/readback, old-writer drain | schema/trigger fingerprint mismatch |
| R4 dual artifact | Create-only raw/client R2 writes, replay, divergence and orphan reconciliation | overwrite, missing digest, semantic conflation |
| R5 protocol v3 | Egress, Controller, DO, runtime, edge N/N-1 matrix | unknown/mixed version accepted |
| R6 financial terminal | Typed-200/non-200 refund or settlement convergence with one immutable audit/outbox decision | duplicate quota/provider/request mutation |
| R7 fault campaign | timeout, response loss, eviction, restart, OOM, R2/D1/DO faults and duplicate delivery | resend from ambiguous evidence |
| R8 canary | isolated synthetic cohort, exact response diff, provider-call count, load/cost/SLO/alerts | customer traffic or unexplained divergence |
| R9 approval | security, finance, operations, product, and rollback owners sign exact evidence bundle | missing/stale approval |

Passing R0-R2 permits only continued local development. Passing R0-R7 may
permit a disabled isolated staging artifact after named approval. Customer
canary requires every row through R9.

## Rollout And Rollback

Rollout is reader-first and disable-first:

1. deploy 0052 readers and v3 parsers while all response-artifact and canary
   writers remain false;
2. prove every active shard and edge artifact can read v1 receipt plus v2
   response artifacts;
3. drain or blue/green isolate any artifact without the new readers;
4. enable raw evidence writing for synthetic operations only;
5. enable client artifact writing only after raw readback;
6. enable terminal consumption only after exact artifact and financial replay;
7. run the full isolated canary and fault campaign; and
8. expand traffic only under the existing approval ladder.

Rollback first disables admission, provider egress, response-artifact writers,
terminal consumption, and scheduler ownership. Readers remain deployed until
every in-flight v3 operation is completed or quarantined. Rollback never
deletes evidence, rewrites a terminal decision, reuses an old namespace, or
resends an ambiguous provider attempt.

## Implementation Packets

1. **P1 shared semantics:** pure interpreter, Worker/egress adapters, source-pinned
   differential corpus, exact header policy, and documentation.
2. **P2 evidence schema:** migration 0052, static/SQLite negative verification,
   R2 namespaces, create-only storage grants, and reconciliation inventory.
3. **P3 protocol:** egress v3 envelope, Controller verifier, DO-local schema,
   runtime rejected outcome, and exact replay.
4. **P4 terminal ownership:** interpreted reject, success usage receipt binding,
   financial CAS/outbox/audit linkage, and scheduled terminalization.
5. **P5 staging proof:** reader-first deployment, N/N-1 or blue/green campaign,
   faults, load/cost/SLO/alerts, rollback drill, and signed approvals.

Local P1/P2 completion does not close P3-P5 and does not change the production
verdict.

## 2026-07-18 Local P1 Evidence

The local P1 implementation is complete as a candidate: Worker and Container
egress consume the shared interpreter, receipt creation is exact-200 only,
typed HTTP-200 failures cannot record successful affinity or billing, existing
non-stream usage estimation remains caller-owned, and interrupted-stream usage
retention remains independently tested.

The source replay generated 27 immutable Go cases: 4 successes, 3 typed errors,
3 invalid bodies, and 17 HTTP errors. The canonical manifest SHA-256 is
`3384f8ec568e082fd2b95ea300df80379d926b4f607cd1d9d80e78f51a8b789a`.
The generator verified source commit, seven source-file hashes, embedded Go
template hash, generator hash, exact case count, unique names, status coverage,
header decisions, and canonical manifest digest. The injected Go test was
removed and the explicit `relay`, `dto`, `service`, and `types` source roots
were clean afterward.

Local verification passed `cargo test -p cinatoken-relay` (102 unit plus 2
manifest tests), `cargo test -p cinatoken-container-egress` (13 tests),
`cargo test -p cinatoken-worker --lib` (833 tests), both Worker and egress wasm
checks, and the complete `bun run check` repository gate. This evidence permits
continued local development only. No Cloudflare remote state, schema, secret,
provider, financial record, or traffic was changed; P2-P5 remain open and
production remains **NO-GO**.

## 2026-07-18 Local P2 Evidence

P2 is implemented as a local candidate. Migration
`0052_relay_container_provider_response_artifacts.sql` first aborts unless all
pre-0052 protocol-v1 chat canary operations in `prepared`, `dispatched`, or
`recovery_required` are drained. The sentinel is migration-local and is dropped
after that check. The persistent schema then adds separate append-only raw
provider evidence and interpreted client artifacts, replacement-resistant
identity ledgers, and independent inventory cursor/finding ledgers. It also
binds the artifact digest into terminal events and fences atomic admission,
usage receipt, operation terminalization, scheduled terminalization, and
reconciliation convergence against incomplete or divergent evidence.

The drain is backed by a persistent writer fence. Migration 0052 adds nullable
operation field `response_artifact_contract` with no default; every new canary
operation must carry exact `container-response-artifacts-v1`, and the value is
immutable. The current Worker writes it explicitly, while an N-1 writer that
omits the column fails before prepared-operation creation and provider I/O.
Each identity ledger also has a `BEFORE INSERT` conflict guard, so direct
`INSERT OR REPLACE` cannot move the sentinel even with
`PRAGMA recursive_triggers=OFF`.

The two R2 authorities remain distinct:

- `container-provider-evidence/v1/<operation>/<owner>/<attempt>/<raw-sha256>`
  stores zero-to-4 MiB provider bytes; and
- `container-client-artifacts/v1/<operation>/<owner>/<artifact-sha256>` stores
  canonical client JSON from 2 bytes through 4 MiB.

The Controller derives both keys, validates the complete grant/body identity,
uses conditional create-only writes, and accepts replay only when key, version,
size, content type, checksum, and custom metadata match exactly. A collision or
missing readback is a conflict, never overwrite authority. Provider evidence
may preserve a null observed content type while R2 uses
`application/octet-stream` only as storage metadata; that fallback is not
promoted into the evidence facts.

The response-artifact inventory is deliberately separate from the historical
0044 result inventory. It has independent provider/client namespaces, immutable
cursor and finding identities, `observe_only` mode, and hard-zero apply/delete
authority. No runtime scanner or activation configuration is included in P2,
so it remains inert until a later reviewed observer packet.

The exact scoped wire contract is frozen in
`docs/container-provider-response-protocol-v3.md`: exact protocol 3, outer HTTP
200 only for a completed provider HTTP response envelope, strict canonical JSON
and base64url validation, separate provider/client statuses and digests, and the
ordered raw-R2 -> raw-D1 -> client-R2 -> success result/receipt -> client-D1 ->
DO usage binding -> DO artifact binding -> financial terminal chain. This
document is a P3 input, not evidence that the egress v3
envelope, Controller verifier, DO-local migration 3, runtime rejected outcome,
or financial terminal path exists.

P2 can retain typed HTTP-200, non-200 2xx/3xx, and receipt-less exact-200
artifacts, but the inherited operation and financial terminal schemas cannot
yet represent all of those outcomes. Local negatives prove typed HTTP-200
cannot use the old failed shape and receipt-less success cannot settle. P3/P4
must add the versioned rejected/terminal authority before any such artifact may
leave a non-terminal state; 0052 storage alone is not a runtime acceptance path.

Local SQLite migration/order/fingerprint/negative verification and Controller
storage-gateway tests pass. No remote D1 migration, R2 object, Durable Object,
Container, deployment, secret, provider call, financial mutation, alarm, or
traffic state changed. P3-P5 remain open and production remains **NO-GO**.

## 2026-07-18 Local P3 Evidence

P3 is now implemented locally. Rust egress owns the source-pinned interpretation
and canonical protocol-v3 envelope; TypeScript verifies transport, identity,
canonical encoding, receipt, and attestations without rebuilding semantics.
The Controller preflights 0052 and immutable admission authority before any
provider path, persists raw and client evidence in separate phases, and attaches
the complete record to DO schema migration 3. The Linux runtime represents an
interpreted rejection separately from recovery and from exact success.

The final 0048/0052-compatible order supersedes the earlier P2 shorthand:

1. raw provider R2 and raw D1;
2. client artifact R2;
3. exact-success-only byte-identical legacy result with exact
   `application/json` metadata and 0048 receipt;
4. client D1 with its optional receipt foreign key; and
5. exact-success DO result/receipt attachment followed by the generation-fenced
   DO response-artifact attachment.

Typed, HTTP, and invalid-body errors never create a legacy result or receipt.
Receipt-less success is rejected before raw R2, even though the frozen protocol
and schema retain nullability for future compatibility.
The pre-dispatch reader reconstructs `complete` state from D1 only, identifies
`raw_only`, rejects client-only/divergent evidence, and treats an existing DO
dispatch with no row as recovery. None of those states can resend the provider.

The active non-streaming P3 profile also narrows the frozen 4 MiB storage bound
to a 1 MiB provider-body limit and a 3.2 MB Controller envelope limit. The
reader preallocates only an exact declared length and drops canonical/base64
copies before storage. Any future increase requires streaming/direct
persistence plus concurrent-isolate memory and fault evidence.

R5 is locally implemented but not promoted. The four response gates remain
false in every tracked environment and the terminal gate additionally hard
fails before provider I/O until R6/P4 supplies one financial CAS/outbox/audit
owner. Remote R3/R4 evidence, real lifecycle/fault proof, R6-R9, and all named
approvals remain open. Production remains **NO-GO**.

## 2026-07-18 Local P4 Evidence

R6/P4 is now locally implemented but not promoted. Controller status v4 reads
the operation, attempt, response artifacts, and receipt as one immutable
snapshot. Migration 0053 adds financial-terminal contract v2 and permits one of
three decisions only:

- exact provider-200/client-200 success settles with the existing immutable
  usage receipt and request accounting;
- typed, HTTP, or invalid-body interpreted rejection writes global failed 422,
  refunds the full reservation, and performs no request accounting; or
- incomplete or ambiguous evidence remains recovery-required without a P3
  terminal binding.

The first two outcomes produce ACK v3, whose request and response bind the
exact provider status/class/evidence and client status/artifact, plus the
receipt only for success. Recovery has no complete response binding and
therefore uses ACK v2. This split prevents an unbound recovery record from
masquerading as a response-backed final acknowledgement.

The Worker also verifies the raw R2 object before convergence: key, version,
checksum, size, content type, 12 custom metadata fields, and the body digest
must match the D1 manifest within the 4 MiB bound. Outbox delivery, scheduler,
reconciliation, client replay, and canary audit consume the same immutable
terminal identity. None of those readers can reinterpret the response or send
the provider request again.

Local negative coverage rejects old-writer downgrade, response-bound recovery,
receipt-free settlement, request accounting on refunds, mismatched R2 evidence,
ACK drift, duplicate identities, and terminal replay conflicts. The complete
repository gate passes with 53 contiguous migrations and 837 Worker unit tests.

R3/R4 remote storage and lifecycle proof and R7-R9 rollout, operations, and
approval work remain open as P5. Every response gate is still false, no
Cloudflare state changed, Go/VPS remains authoritative, and production remains
**NO-GO**.
