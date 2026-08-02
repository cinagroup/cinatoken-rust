# ADR 0001: TypeScript Control Plane and Rust Container Compute Boundary

- Status: Accepted
- Date: 2026-08-01
- Decision scope: target Cloudflare architecture, language ownership, migration gates, and retirement policy
- Production posture: NO-GO until the gates in this ADR are satisfied with remote evidence

## Authority

This ADR is the authoritative decision for the target language and runtime
boundary of the Cloudflare migration. If it conflicts with any historical
description in the following documents, this ADR wins for target architecture
and component ownership:

- `docs/cinatoken-rust-migration-plan.md`
- `docs/layered-gateway-architecture.md`
- `docs/cinavibesdk-production-migration-mapping.md`

Those documents remain useful implementation history and evidence ledgers. This
ADR does not invalidate their verified tests, migration records, business
semantics, or production blockers. It supersedes only incompatible target-state
language allocation and the resulting retirement sequence.

## Context and audit findings

The audit reviewed the three cinatoken-rust documents above and the current
local cinaVibeSDK architecture sources at commit
`918e97480ee44e357abe99bf33c27259d6ac7ebd`:

- `C:\cinagroup\cinavibesdk\docs\architecture-diagrams.md`
- `C:\cinagroup\cinavibesdk\README.md`, especially "Built on Cloudflare's
  Platform" and "Architecture Deep Dive"
- `C:\cinagroup\cinavibesdk\space\README.md`
- `C:\cinagroup\cinavibesdk\wrangler.jsonc` as the executable architecture
  declaration

The audit found:

1. The durable four-layer topology is sound: edge ingress, deterministic
   stateful coordination, replaceable Container compute, and external durable
   storage have distinct responsibilities.
2. cinaVibeSDK implements its platform control plane as TypeScript Workers and
   TypeScript Durable Objects/Agents. Its architecture documents place API
   routing and services in Workers, persistent session/agent state in Durable
   Objects, disposable execution in Containers, and durable data in D1, KV,
   and R2. The reviewed tree contains no Rust crate.
3. `docs/layered-gateway-architecture.md` and the opening target sections of
   `docs/cinavibesdk-production-migration-mapping.md` correctly recognize that
   TypeScript provenance, but then translate the edge gateway, core session DO,
   and tenant execution path into Rust/Wasm. That translation is no longer the
   target architecture.
4. `docs/cinatoken-rust-migration-plan.md` contains both the older Rust Worker
   target and a newer TypeScript `RelayShardContainer` Controller plus Rust
   Linux Container runtime. The newer Controller/Container separation is the
   reusable foundation; the Rust edge and core Rust DO ownership are
   transitional.
5. The current TypeScript Controller and Rust Container duplicate important
   operation envelopes in handwritten JSON types. Without a generated
   cross-language contract, field, enum, validation, and compatibility drift is
   a production risk.

cinaVibeSDK is an architectural reference, not a source of cinatoken business
truth. cinatoken authentication, model/channel policy, quota, billing,
settlement, audit, and disable semantics must retain their independently
verified behavior throughout the migration.

## Decision

The target production path is:

```text
Client
  -> TypeScript edge ingress Worker
       -> TypeScript core session DO, when session ordering is required
       -> TypeScript sharded scheduler/controller DO cluster
            -> private binding to cinatoken-rust Linux Container compute
                 -> KV / D1 / R2, according to the authority rules below
```

The non-negotiable invariants are:

- The edge ingress Worker is TypeScript.
- Core session and sharded scheduler/controller Durable Objects are TypeScript.
- `cinatoken-rust` compute runs in Linux Containers, not as the owner of the
  edge or core Durable Object control plane.
- Protobuf and OpenAPI are required TypeScript/Rust contracts.
- Existing Rust Worker/DO code is a transition compatibility layer, and core
  session/shard DOs must not be migrated wholesale to Rust Wasm.

For non-session requests, the edge Worker may address the selected shard DO
directly. For session requests, the session DO owns session ordering and calls
the selected shard boundary without creating a second owner for the same state
transition.

The language allocation is fixed:

| Layer or concern | Required implementation | Owns | Must not own |
| --- | --- | --- | --- |
| Edge ingress | TypeScript Worker | Public route classification, request bounds, authentication orchestration, admission, rate-limit invocation, policy lookup, request canonicalization, trace creation, and deterministic dispatch | Provider compute, durable session ordering, shard lifecycle, or a second billing state machine |
| Core session coordination | TypeScript Durable Object | WebSocket/session identity, ordered state transitions, hibernation-safe metadata, bounded queues, alarms, replay fences, and session recovery decisions | Durable provider secrets, global financial truth, arbitrary compute, or container-local recovery assumptions |
| Sharded scheduling and lifecycle | TypeScript Durable Object/Container Controller | Stable shard identity, ring-generation fences, operation leases, replay/idempotency state, capacity, alarms, drain state, and Container lifecycle | User-facing authentication policy, repricing, settlement, provider fallback policy, or global relational truth |
| Compute | Rust `linux/amd64` Container | Bounded CPU-heavy transforms, provider protocol adapters, approved provider I/O, usage parsing, and other Linux-native execution delegated by an admitted immutable operation | Public ingress, shard selection, session authority, retry ownership, quota authorization, settlement authority, or durable truth on local disk |
| Durable data | D1, DO SQLite/storage, R2, and KV | D1: relational and financial truth; DO storage: session/shard-local coordination; R2: immutable large payloads and evidence; KV: versioned cache and non-authoritative configuration | KV as financial or replay truth; R2 as mutable coordination; Container disk as recovery authority |

All platform-owned edge routing and core Durable Object code in this path is
TypeScript. User-supplied Workers for Platforms artifacts are outside this
decision, but they cannot own or bypass core session, shard, admission,
billing, or security policy.

## Cross-language contracts

Protobuf and OpenAPI are mandatory at every TypeScript-to-Rust boundary.
Handwritten duplicate request or response DTOs are not an accepted production
contract.

1. Protobuf is the canonical message schema for immutable admitted operations,
   operation results, status, typed errors, usage, and reconciliation records.
   Packages and messages are versioned, field numbers are never reused, removed
   fields are reserved, and enums include an explicit `UNSPECIFIED` value.
2. OpenAPI is the canonical HTTP transport contract. It defines private paths,
   methods, headers, media types, status codes, body limits, deadlines, error
   responses, and public JSON/SSE/WebSocket compatibility surfaces. The private
   Container endpoint carries Protobuf messages using an explicitly versioned
   media type and framing rule.
3. TypeScript and Rust types must be generated from checked-in schemas. Local
   adapters may convert generated types into domain types, but may not recreate
   the wire model by hand.
4. CI must run schema formatting/linting, backward-compatibility checks,
   deterministic generation, generated-tree drift checks, OpenAPI validation,
   and bidirectional golden vectors: TypeScript encode to Rust decode and Rust
   encode to TypeScript decode.
5. Every effect-capable request includes contract version, operation ID,
   dispatch ID, tenant scope, shard ID, ring generation, owner generation,
   absolute deadline, idempotency key, payload digest, and release identity as
   applicable. Security-critical enums, versions, and claims are allowlisted;
   unknown values fail closed.
6. Compatibility is additive within a major version. N and N-1 readers/writers
   must be tested before a rolling deployment. A request must never downgrade
   after a provider side effect may have started.
7. External OpenAI-compatible JSON, SSE, and WebSocket protocols remain edge
   contracts. They are not exposed directly by the Container and do not weaken
   the private Protobuf boundary.

## Existing Rust Worker and Durable Objects

The existing Rust Worker and Rust/Wasm Durable Objects are a transition
compatibility layer, not the target control plane. During migration they may:

- preserve currently implemented compatibility behavior;
- receive security, correctness, observability, and contract-adapter fixes;
- provide shadow/parity evidence and an explicitly gated rollback path; and
- continue to serve unmigrated cohorts until their replacement gates pass.

They must not gain new long-term route ownership, become the source of new
control-plane state, or be used as the default location for new session/shard
features. New target-path control-plane work belongs in TypeScript.

Core session or shard Durable Objects must not be migrated wholesale to Rust
Wasm for language unification or speculative performance. A Rust Wasm module
may be considered later only for a profiled, deterministic, CPU-bound, pure
function with no binding, storage, alarm, WebSocket, lifecycle, authorization,
or retry ownership. It requires a stable generated ABI, TypeScript ownership
around it, reproducible benchmarks, negative tests, and a fail-safe TypeScript
fallback. It can never become the core session or shard state machine.

## Migration stages and exit gates

Promotion is manual and evidence-based. A failed gate returns traffic to the
last proven stage; no stage promotes itself.

### Stage 0: Freeze ownership and inventory

- Publish this ADR and classify every public route, Durable Object class,
  service binding, queue consumer, alarm, cron, and storage write by current and
  target owner.
- Freeze new feature ownership in the Rust Worker/core Rust DO layer except for
  parity, security, correctness, and rollback work.
- Record the Go/VPS, Rust compatibility, and TypeScript target paths separately.

Exit gate: no route or side effect has an unnamed owner; all target ownership
conflicts resolve to this ADR; all migration flags default off outside an
approved cohort.

### Stage 1: Establish generated contracts

- Check in versioned Protobuf and OpenAPI schemas and generation commands.
- Replace handwritten cross-language wire types at one private operation path
  with generated types and adapters.
- Prove body limits, malformed input handling, unknown versions/enums, N/N-1
  compatibility, and bidirectional golden vectors.

Exit gate: contract lint, breaking-change checks, deterministic generation,
TypeScript tests, Rust tests, and cross-language vectors pass in CI; no
effect-capable path can bypass the versioned contract.

### Stage 2: Introduce the TypeScript edge ingress

- Deploy the TypeScript edge with no traffic authority and no public fallback
  URL to private services.
- Shadow route classification, admission inputs, and dispatch planning without
  issuing provider, billing, or storage side effects.
- Forward an explicitly selected compatibility cohort to the existing Rust
  path through a private service binding while preserving one request identity.

Exit gate: route and auth decision parity is explained or zero-diff for the
approved surface; origin/CORS/CSRF, body limits, rate limits, redaction,
timeouts, and rollback are proven in staging; shadow execution causes no
duplicate effect.

### Stage 3: Move core session authority to TypeScript DOs

- Create deterministic session identities and persist state before accepting an
  effect that must survive eviction.
- Prove WebSocket hibernation, reconnect semantics, queue bounds, alarm replay,
  DO eviction/restart, upstream close/error, and backpressure behavior.
- Keep billing and global recovery in their existing durable authority until a
  separately proven migration moves them.

Exit gate: staging fault campaigns show no secret persistence, no lost or
duplicated settlement command, no cross-session state, and deterministic
recovery from every ambiguous terminal state. Rust session DO routing remains
available only behind the explicit rollback gate.

### Stage 4: Make TypeScript shard DOs the scheduler authority

- Route by keyed deterministic identity and a versioned ring; persist operation,
  lease, fence, replay, capacity, drain, and lifecycle state in DO SQLite before
  Container startup or dispatch.
- Exercise isolate eviction, alarm duplication, stale generation, split rollout,
  capacity exhaustion, drain, Container crash/replacement, and storage failure.
- Ensure one component owns provider retry and one D1 transaction owns each
  financial terminal decision.

Exit gate: remote staging proves stable shard placement, N/N-1 overlap,
persist-before-effect, no stale-owner send, bounded overload, and safe rollback
with accepted work drained or reconciled.

### Stage 5: Activate Rust Container compute

- Invoke only through a private binding and the generated contract.
- Pin the image by digest; verify provenance, SBOM, signature, vulnerability
  policy, non-root execution, minimal capabilities, read-only runtime where
  practical, egress allowlists, and resource limits.
- Treat local files, memory, sockets, and process identity as disposable.

Exit gate: health/readiness, cold start, stop/start/replacement, timeout,
network ambiguity, provider fault, load, cost, and D1/DO/R2 reconstruction are
proven remotely. Container loss cannot authorize a new attempt or erase an
existing obligation.

### Stage 6: Canary and production cutover

- Promote by explicit tenant/token cohorts and then bounded percentages. Each
  step requires predeclared latency, error, cost, saturation, billing-diff, and
  reconciliation thresholds.
- Archive contract versions, release/image identities, configuration readback,
  security negatives, fault results, financial reconciliation, and a timed
  rollback rehearsal.
- Never combine language cutover, schema authority cutover, retry-policy change,
  and billing-policy change in one promotion.

Exit gate: the complete edge -> TypeScript DO -> Rust Container -> storage path
meets SLOs, has zero unexplained financial or audit diff, and completes the
required soak window. Go/VPS remains authoritative until its own cutover gate
is explicitly approved.

### Stage 7: Retire the Rust compatibility control plane

- Remove production route ownership first, then disable alarms, consumers,
  bindings, and writes; drain and reconcile all accepted work before deleting
  code or namespaces.
- Observe zero production invocation and zero pending state for at least 30
  consecutive days, including a rollback drill using retained immutable build
  artifacts.
- Confirm no D1 row, DO state, queue message, R2 object, audit query, runbook, or
  dashboard still depends on the retiring Rust Worker/DO owner.

Exit gate: operators sign off route inventory, state reconciliation, billing
parity, security evidence, rollback expiry, and retention obligations. Code,
bindings, and migrations are removed only in later deliberate changes, never as
an incidental part of traffic cutover.

## Failure principles

1. Fail closed for authentication, authorization, contract version, signature,
   replay, idempotency, quota, billing prerequisites, shard/ring identity,
   credential retrieval, and unknown durable state. Fail-open is permitted only
   for explicitly non-authoritative cache or telemetry loss.
2. Persist intent and ownership before external effect. Exactly-once delivery is
   not assumed; use stable operation IDs, idempotency keys, CAS, replay records,
   and reconciliation.
3. A timeout is an unknown outcome, not proof of cancellation. After an
   ambiguous provider send, do not silently try another shard, Container,
   provider, Rust compatibility path, or Go/VPS path. Reconcile the same
   operation identity.
4. One layer owns retry. Edge, session DO, shard DO, Container, AI Gateway, and
   compatibility paths must not stack independent retries.
5. DO eviction and alarm duplication are normal. Every alarm and recovery path
   is idempotent, bounded, generation-fenced, and safe after arbitrary restart.
6. Container disk and memory are ephemeral. Recovery comes from DO/D1/R2 state;
   local receipts can strengthen evidence but cannot become global truth.
7. Apply one absolute deadline budget across hops. Bound request/response bodies,
   queues, frames, logs, and concurrency; reject overload with stable retryable
   errors before accepting new work.
8. Storage partial failure produces an explicit pending/ambiguous state and an
   observable reconciliation obligation. It must not be converted into success
   or discarded as best-effort cleanup.

## Security principles

1. Public requests terminate only at the TypeScript edge Worker. Core DOs,
   Controller endpoints, and Containers have no public fallback URL.
2. Internal calls use service bindings plus short-lived, audience-, method-,
   path-, body-, tenant-, operation-, generation-, and deadline-bound claims.
   Replay is consumed durably before an external effect.
3. End-user bearer tokens are removed before internal dispatch. Provider and
   platform credentials are least-privilege, request-scoped where possible,
   and never persisted in DO storage, D1 operation payloads, KV, R2 artifacts,
   WebSocket attachments, logs, traces, or error bodies.
4. Tenant identity is carried as a verified scope, not trusted from a caller
   header. Deterministic object names use a keyed, environment-separated
   derivation when raw identifiers would leak or permit cross-tenant guessing.
5. All external URLs, redirects, headers, methods, media types, and response
   headers are allowlisted. The Container cannot use caller-controlled base URLs
   or credentials to bypass egress and SSRF policy.
6. Authorization is decided once by the owning control-plane policy and then
   represented as a narrowly scoped capability. Defense-in-depth checks verify
   that capability; they do not invent a second, divergent policy engine.
7. Logs and evidence use stable fingerprints and release/operation identifiers,
   never raw secrets or full sensitive payloads. Redaction has automated
   negative tests at every layer.
8. Every release records edge version, DO version, contract version, ring
   generation, Container image digest, and storage migration set. Production
   mutation requires least-privilege identities, separation of duties, and
   auditable rollback.

## Consequences

Positive consequences:

- The target matches the cinaVibeSDK Workers/Agents operational model while
  retaining Rust where Linux-native compute provides clear value.
- Durable coordination uses the Cloudflare-native TypeScript APIs with the
  strongest ecosystem and generated binding support.
- Generated contracts make the polyglot boundary explicit and testable.
- Container replacement, DO eviction, and rolling deployment become designed
  failure modes instead of implicit assumptions.

Costs and tradeoffs:

- The repository must maintain TypeScript and Rust build/generation toolchains.
- Private dispatch adds serialization and one or more service/DO hops.
- Migration temporarily carries old and new implementations and therefore
  requires strict single-owner flags, shadow discipline, and reconciliation.
- Performance work must start with responsibility placement and measured hop
  costs; speculative Rust Wasm rewrites of control-plane state machines are not
  available as a shortcut.

## Rejected alternatives

- **Rust Worker and Rust/Wasm DOs everywhere:** rejected because it discards the
  reference stack's TypeScript control-plane strengths, increases platform API
  friction, and does not justify moving stateful session ownership for
  speculative performance.
- **TypeScript everywhere, including compute:** rejected because provider
  adapters, CPU-heavy transforms, Linux-native libraries, and hardened runtime
  isolation are valid Rust Container responsibilities.
- **Handwritten JSON as the internal contract:** rejected because duplicate
  TypeScript/Rust validators can drift without detectable wire compatibility.
- **Core session state in the Container:** rejected because Container lifetime
  and local disk are replaceable and cannot own durable ordering or recovery.
- **Silent fallback to another runtime after ambiguity:** rejected because it
  can duplicate provider effects, charges, settlement, and audit records.

## Non-goals

This ADR does not change billing expressions or settlement semantics, authorize
a Cloudflare deployment, declare production readiness, remove existing code or
bindings, or modify historical evidence. Implementation, contract files,
deployment configuration, and retirement changes require separate reviewed and
verified increments.
