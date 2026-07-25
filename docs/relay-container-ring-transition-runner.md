# Relay Container Ring Transition Runner

## Decision

The staging ring transition is executed only by a compiled Rust launcher whose
release-policy digest, release-key fingerprint, three fixed sidecar names, and
Authority origin are embedded at build time. The signed release manifest is a
detached sidecar produced after the executable is built; it binds the finished
executable digest without creating an impossible binary-self-hash cycle. The
checked-in launcher is permanently disabled and cannot be enabled by argv,
environment, a writable checkout, or a caller-selected trust file.

The JavaScript execution contract and native transport remain the portable,
fault-injectable reference implementation. They do not themselves constitute a
production trust root. No checked-in command currently authorizes a Cloudflare
mutation.

## Source design applied

The implementation keeps the useful parts of the two source systems while
rejecting their process-local assumptions:

- cinaVibeSDK creates content-addressed deployment manifests and separates pure
  deployment configuration from the side effect. The runner likewise freezes
  a canonical mutation request and digest before any POST.
- cinaVibeSDK resolves a create conflict by reading the existing session and
  validating its identity. A claim conflict or response loss is handled only
  by an exact claim readback; it never creates a replacement claim silently.
- cinatoken Go uses status-qualified updates and `RowsAffected` to identify the
  transition winner. The Authority D1 ledger strengthens this into an ordered
  claim/state-version protocol.
- bounded retry from cinaVibeSDK is retained only for future authenticated GET
  readback. Deployment POST remains exactly once. Go relay failover and channel
  switching are not valid deployment-mutation semantics.

The source patterns that are intentionally not copied are modulo-based shard
remapping, catch-all create recovery, recursive deployment retries, best-effort
secret updates, and process-local scheduler guards.

## Implemented components

### Compiled launcher

`crates/ring-transition-runner` is a standalone Rust binary with exactly two
commands:

```text
cinatoken-ring-transition-runner --describe
cinatoken-ring-transition-runner --execute
```

It accepts no runtime config, trust key, runner path, account, service, target,
credential, origin, or force argument. Its checked-in `releaseTrust` has
`enabled=false`, fixed packet/policy file names, and null policy/key/origin
pins. `--execute` therefore fails before
reading credentials or using the network even when poison environment values
attempt to enable or replace trust.

The compiled trust root reserves only non-circular anchors:

- `cinatoken-ring-transition-runner.release.json`;
- `cinatoken-ring-transition-runner.release-policy.json`;
- `cinatoken-ring-transition-runner.publication.json`;
- exact release-policy SHA-256;
- independent release-key SPKI SHA-256; and
- exact staging Authority origin.

Commit/tree/archive/lock/module/build/evidence/Authority-version/permit-SPKI
identities live in the DSSE-signed manifest. A production launcher will verify
the fixed policy and packet against the compiled anchors, hash its current
executable, compare it to the signed artifact identity, and require the signed
target triple to match the launcher's compile-time architecture/OS/ABI.

### Rust detached-release verifier

`crates/ring-transition-runner/src/release.rs` now owns the production-language
release-verification boundary. `--execute` validates the checked-in trust
configuration before reading the clock, current executable, sidecars,
credentials, or network. Because the checked-in pins remain disabled/null,
the repository build still fails at that first gate.

For an enabled release build, the verifier reads only the current executable
and the two fixed sibling names. It then enforces:

- bounded, canonical, duplicate-free policy, packet, manifest, and module
  inventory JSON with exact fields;
- exact compiled policy digest, release-key SPKI digest, and Authority origin;
- one Ed25519 signature over standard DSSE PAE and whole-second bounded
  policy/release validity windows;
- a sorted key-separation inventory that contains the manifest permit key and
  excludes release/permit key reuse;
- the complete 20-path transitive module closure, portable paths, module
  counts/bytes/digests, Git/lock/package identities, and two-build equality;
- exact evidence, Authority version, executable name, byte length, signed
  digest, and current executable bytes; and
- a Windows/MSVC or Linux/musl target that matches the launcher's compile-time
  x86_64 architecture/OS/ABI at installation-time verification.

Stable file reads reject symlinks, non-regular or empty files, path movement,
parent escape, replacement between metadata/read checks, and Unix hardlinks.
The JavaScript pre-install verifier additionally rejects Windows hardlinks.
That Windows source link-count check remains an installation-ceremony control
rather than a claim made by the Rust runtime verifier.

### Signed publication and append-only activation

`crates/ring-transition-runner/src/publication.rs` now verifies and consumes a
second DSSE domain signed by the independent release key. Its canonical
publication manifest binds the already verified policy, release packet and
executable identities, target/Authority/source identities, a deterministic
three-file generation digest, a monotonically increasing activation sequence,
and the exact previous publication-manifest digest.

The publication packet cannot grant remote authority. It authorizes only one
local create-new generation:

```text
<install-root>/
  publications/
    publication-<publication-manifest-sha256>/
      cinatoken-ring-transition-runner[.exe]
      cinatoken-ring-transition-runner.release.json
      cinatoken-ring-transition-runner.release-policy.json
      cinatoken-ring-transition-runner.publication.json
  activations/
    <20-digit-sequence>.activation.json
```

The installer consumes a non-cloneable verified candidate, creates every file
with `create_new`, flushes it, re-verifies the installed bytes, makes the
generation read-only, and creates the activation record last. An existing
directory/file or sequence is a conflict, never an overwrite. Sequence `1`
requires no predecessor; every later sequence requires the exact prior
activation record. Concurrent candidates for the same sequence race on one
fixed create-new activation path, so at most one becomes active. A crash may
leave an incomplete, unactivated generation; the production response is
quarantine/forward repair, not deletion or silent reuse.

Runtime authorization now requires the publication directory name, exact
compile target, all four sibling bytes and the append-only activation record
to agree before any credential handle is opened. The activation record also
binds the exact outer publication-packet digest, closing substitution outside
the signed payload without creating a self-hash cycle.

### Rust activated credential boundary

`crates/ring-transition-runner/src/credentials.rs` now owns the next local
capability boundary. The current-publication verifier and
`ActivatedPublication` are crate-private. Runtime code cannot pass alternate
release trust to mint activation, and `authorize_execution` consumes
activation directly into opaque loaded credentials.

A second compiled trust object remains independently `enabled=false` with
null pins. An enabled one-shot staging build must pin the exact:

- account, read, claim and deploy credential identity SHA-256 values;
- Authority origin, version, issuer, audience and HMAC key ID;
- permit SPKI and runner trust-config SHA-256 values; and
- fixed Cloudflare API origin.

The three credential identities must differ. The Authority version, permit
SPKI and trust-config digest must also equal the values carried through the
activated signed release before any environment access.

Only the four documented handles can be read. The loader does not enumerate
the environment or accept aliases, CLI values, files or caller-provided
sources. It reads the account first, requires 32 lowercase hexadecimal
characters and matches its SHA-256 before reading secrets. Each secret must be
32-4096 UTF-8 bytes, contain no whitespace and differ from the other two.
Secret bytes are held in a zeroizing wrapper with no clone, debug, display or
serialization implementation.

The proof core is consuming typestate:

```text
LoadedCredentials
  -> ReadCredentialProven
  -> DeployCredentialProven
  -> PendingAuthorityPreflight
  -> VerifiedCredentials
```

Cloudflare token proof requires duplicate-free bounded JSON, `success=true`,
`status=active`, and the exact SHA-256 of the returned token ID. The claim
proof emits the Authority-compatible 30-second HS256 token and accepts only an
exact request ID, claim credential ID, Authority version, permit SPKI and
`authority_ready` preflight response. These proof types and raw secret access
remain private to the library; the future HTTP client must consume them rather
than accept caller-created identities.

The JavaScript reference transport now clears all three proof flags before
every verification and commits them only after read, deploy and private
preflight all succeed. Any failure leaves all three false. Public preflight
requests are rejected, and every other Authority request requires all three
proofs. Rust, JavaScript and the Authority protocol tests share one exact HMAC
vector, including canonical JSON and signature bytes.

This is not a live identity client. Cloudflare token verification proves
active ID, not least-privilege scopes; retained owner/scope/revocation evidence
is still mandatory. The Authority also requires a reviewed Cloudflare Access
workload identity. HMAC and Ed25519 permit verification do not replace Access,
so a fixed service-token or reviewed WARP/mTLS design must be selected before
the Rust client is linked.

### Detached release packet

`relay_container_ring_transition_release_contract.mjs` and
`verify_relay_container_ring_transition_release.mjs` now implement the offline
release packet contract:

- canonical JSON with exact fields and one standard DSSE PAE;
- exactly one Ed25519 signature and one external release policy;
- issue/expiry bounds and a sorted forbidden-key fingerprint inventory;
- exact Authority origin/version, permit SPKI, trust config and evidence
  digests;
- full Git commit/tree/archive and lock/package digests;
- sorted portable module paths, byte counts and complete SHA-256 values;
- identical first/second/normalized build and artifact digests; and
- fixed sibling artifact read with byte bounds, TOCTOU checks, and
  symlink/hardlink rejection.

CLI verification deliberately has no compiled pins and reports
`releaseInstallAuthorized=false`. It proves packet consistency only.

`collect_ring_transition_runner_release_source.mjs` reads only a completely
clean Git repository. It hashes `git archive HEAD` and reads every required
module from `HEAD:<path>`, never from mutable checkout bytes. It rejects tracked
changes, untracked files, submodules, forbidden modes, missing transitive
verifier modules, path escape, truncated Git identity, and oversized output.
The collector has no injectable Git runner and starts Git with an explicit
minimal environment that drops ambient `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_CONFIG_*`, credential-helper, and interactive-prompt controls. It emits
an unsigned candidate to stdout and writes no file.

### Native transport

`relay_container_ring_transition_native_transport.mjs` implements the bounded
staging transport without adding a live CLI execution path. It reads only four
fixed handles:

```text
CINATOKEN_RING_TRANSITION_ACCOUNT_ID
CINATOKEN_RING_TRANSITION_READ_TOKEN
CINATOKEN_RING_TRANSITION_CLAIM_HMAC_SECRET
CINATOKEN_RING_TRANSITION_DEPLOY_TOKEN
```

The raw account ID must hash to the embedded account identity. Read, claim, and
deploy credential IDs must be pairwise distinct. Read and deploy tokens are
verified against the account token-identity endpoint before use. The claim
HMAC is proven by an authenticated, read-only Authority preflight before any
claim POST.

Credential proof is now atomic in the reference transport. The preflight is a
private method and cannot independently enable claim traffic. Revalidation
sets all three proof flags false before work and sets them true only after all
three exact proofs succeed.

The transport has no console logging, credential serialization, retry loop,
subprocess, Wrangler, SDK mutation helper, arbitrary URL, or caller-provided
Authorization header.

Published JavaScript trust anchors are canonicalized into a new plain-data
snapshot and recursively frozen before the transport stores them. Later
changes to the caller object, including nested approval-key arrays or getters,
cannot alter the allowlist. Transition-approval, authorization-approval, and
claim-permit SPKI fingerprints must be pairwise disjoint.

`deployOnce` no longer accepts a request descriptor by itself. A deployment
requires an opaque `freshIntentPermit` created by this transport instance only
when the Authority returns an exact, identity-bound `step_appended` response
for `controller_mutation_intent` or `edge_mutation_intent`. The permit binds
the authorization ID, claim digest, state version, step code, and persisted
request digest. It is consumed before validation or network I/O, cannot be
cloned or reconstructed, and is never issued for `step_replayed`, ambiguous
responses, or restored inflight state.

The canonical Cloudflare body carries one target at 100 percent and a bounded
annotation containing the complete authorization ID, exact state version, and
a semantic intent digest over claim, service, and target. Before `fetch`, the
transport also matches the claim's account, ledger, policies, services,
runner/trust identities, credential identities, and validity window; then it
matches the URL, body, annotation, and body digest to the freshly appended
intent. Any mismatch spends the permit and performs zero Cloudflare mutation.

### Authority preflight

The Authority Worker now exposes:

```text
GET /internal/v1/ring-transition/preflight
```

It is protected by the Authority master gate and the same method, path/query,
body, credential, request-ID, issuer, audience, key-ID, and time-bound HMAC as
the ledger APIs. It does not require a write gate and does not access D1. Its
response binds:

- authenticated claim credential ID;
- exact Authority Worker version ID; and
- permit SPKI fingerprint.

The transport compares all three against compiled trust before claim traffic.

## Outbound allowlist

| Credential | Allowed requests | Forbidden |
| --- | --- | --- |
| Read | account token verify; exact pinned Controller/Edge deployment and version GET | POST, arbitrary service/account/origin, redirects |
| Claim | exact Authority preflight, claim create/read, step, and expiry routes with per-request HMAC | arbitrary path/query, general D1/SQL, caller Authorization header |
| Deploy | account token verify; one exact pinned Controller or Edge deployment POST carrying a same-process fresh Authority intent permit | replayed/restored intent, upload, force, delete, secret/binding/resource mutation, second POST |

Every request uses HTTPS, `redirect=error`, a 10-second timeout, streamed bounded
response parsing, strict JSON success handling, and no retry. Authority request
bodies are limited to 64 KiB and deployment request bodies to 16 KiB. The
deployment request digest must equal the exact canonical body bytes.

## Result classification

| Observation | Classification | Next action |
| --- | --- | --- |
| Valid 2xx JSON with expected Authority identity or Cloudflare success envelope | `success` | Continue only through the persisted state machine |
| Deterministic validated Cloudflare 4xx | `rejected` | Persist `recovery_required/http_rejected`; never resend |
| 408, 425, 429, any 5xx, timeout, connection loss, truncation, oversized or invalid success body | `ambiguous` | Never resend; perform stable authenticated target readback |
| Authority `503` with `outcome_unknown=true` | `ambiguous` | Exact claim readback only |
| Unpinned origin, path, service, version, Authority version, SPKI, issuer, audience, key ID, body digest, or credential identity | local failure | Zero mutation |

Response bodies, request IDs, Cloudflare request IDs, and evidence are retained
only as bounded hashes or allowlisted fields. Raw tokens and HMAC material are
never part of a receipt.

## Required signed release

The packet schema, verifier, and source collector now exist. An enabled runner
remains blocked until a separate release pipeline actually produces a signed,
create-new artifact packet outside the writable checkout. The packet must
contain:

1. strict canonical release manifest with no unknown fields;
2. exact Git commit/tree and clean source-archive digest;
3. lockfile, package, toolchain, target, build-argument, and fixed environment
   allowlist digests;
4. sorted module/file inventory with byte counts and SHA-256 digests;
5. two independently extracted and isolated builds with identical artifact
   digest;
6. Node, Rust, Workerd, fault, security, and no-secret test evidence bound to
   that artifact;
7. exact Authority origin/version and permit SPKI fingerprint;
8. release policy and independent Ed25519 release-key fingerprint; and
9. DSSE signature with issue/expiry bounds and keys distinct from transition,
   authorization, HMAC, and Cloudflare credentials.

The signed manifest includes the executable digest but not its own envelope or
distribution-package digest. A separate publication receipt hashes the policy,
packet and executable after signing; this avoids a second self-reference.
The final artifact must be installed by digest outside the source checkout.
The launcher now verifies compiled pins, fixed sidecars, DSSE, manifest,
current executable and compile target before reading the four runtime handles.
The local installer/verifier now retains the separate signed publication
packet and create-new activation record before the generation is executable as
an authorized release. A real ceremony must still run it outside the writable
checkout under an operator-owned installation root.

## Rust resumable core

`crates/ring-transition-runner/src/orchestrator.rs` now owns the first
production-language state-machine boundary. It remains a pure, offline library:
it has no credential, clock, filesystem, HTTP, D1, Cloudflare SDK, subprocess,
or remote mutation capability.

The module parses one bounded Authority snapshot with strict structs,
unknown-field rejection and recursive duplicate-key detection. It recomputes
the canonical claim, step and expiry SHA-256 values using the same ASCII-key
ordering and JavaScript-safe integer domain as the Authority contracts. It
then proves:

- claim/state identity and timestamp binding;
- a continuous state-version history across step and expiry rows;
- exact `from_status -> to_status` and step-shape legality;
- claim-owner execution steps and a distinct Authority expiry actor;
- pre-mutation/read-only steps occur before claim expiry, while only an
  already-inflight Controller/Edge post-readback may be recorded afterward;
- post-readback request digests equal the immediately preceding mutation
  intent; and
- the final state, version, update time and terminal time agree with the
  reconstructed history.

This closes a sequential-query failure mode: independently valid claim, state,
step and expiry query results cannot be assembled into a mixed-version
snapshot and treated as one execution state.

The reducer returns only:

```text
ReadT1
AppendControllerIntent
ObserveController
ReadEdgePrevious
AppendEdgeIntent
ObserveEdge
AwaitAuthorityExpiry
AwaitAuthorityRecovery
SealReceipt
```

There is deliberately no `Deploy` decision. A restored
`controller_inflight` or `edge_inflight` snapshot always returns an observation
decision, including after authorization expiry.

For a new mutation, the library creates a typed
`PreparedMutationIntent<ControllerMutation|EdgeMutation>`. Beginning an
Authority append consumes that intent and binds a request ID in a non-cloneable
`AuthorityAppendAttempt<S>`. Only an exact, bounded, duplicate-free
`step_appended` response with matching request ID, authorization, claim,
Authority version, target status, state version and step digest consumes the
attempt into `FreshIntentPermit<S>`. `step_replayed` returns no permit. The
permit is private, non-cloneable and non-serializable; binding the exact
canonical Cloudflare request digest consumes it again into
`AuthorizedMutation<S>`. The claim generation and expiry bounds travel through
the capability chain; the final bind rejects `now < generated_at` and
`now >= expires_at`, and the authorized value retains both bounds for the
future sole POST call site to recheck immediately before network I/O.

The new module is included in both required release-module inventories. A
signed runner packet that omits or changes the Rust orchestrator therefore
cannot satisfy the release verifier.

## Remaining execution boundary

The pure core is not a live executor. The next code boundaries are:

1. build bounded Cloudflare identity and Authority clients that consume the
   Rust credential typestates, use an explicit reviewed Access workload
   identity, and perform no ambient proxy/redirect/retry behavior;
2. obtain a transactionally coherent Authority
   snapshot or detect query-version drift, then feed only verified bytes to
   the reducer;
3. implement authenticated Controller/Edge deployment readers with a
   signed-policy timing window for two stable observations;
4. join `AuthorizedMutation<S>` directly to the sole deployment POST call site
   so no request can be sent from a restored snapshot or reusable descriptor;
5. append immutable readback outcomes and seal a create-new, hash-chained,
   redacted execution receipt; and
6. inject process death before and after release/publication verification,
   claim, every
   Authority append/readback, the one deployment POST, each stable read and
   each receipt append.

Acceptance requires lifetime Cloudflare deployment history of at most one POST
per service and exact target proof after every ambiguous response. A crash
before the Authority confirms a fresh intent may retry only the Authority
append and receives replay/no permit if the original write committed. A crash
after fresh intent confirmation but before/during/after deployment cannot
recreate the in-memory permit; restart is readback-only.

## Local verification

```powershell
bun run check:ring-transition-authority
bun run check:ring-transition-runner
bun run check:relay-container:ring-transition
```

These commands prove the local fail-closed contracts only. No control D1,
Authority deployment, route, Access policy, secret, signed runner release,
Cloudflare mutation, customer traffic, or Go/VPS cutover is established.
Production remains **NO-GO**.

## Terminal Receipt Store Boundary

The runner now contains a library-owned terminal receipt projection and
create-new store. A verified terminal `AuthoritySnapshot` is converted into
one genesis record, one record for each ordered Authority step or expiry
event, and one terminal seal. Every record repeats the release, publication,
credential and claim identities and binds the exact predecessor canonical-byte
SHA-256.

The store accepts an existing slot only when its bytes are exactly equal.
Missing predecessors, gaps, identity drift, noncanonical or linked files,
semantic step/expiry digest drift, and records after a terminal seal fail
closed. The Linux publisher uses no-follow directory/file handles, exclusive
staging, file sync, directory-FD no-replace rename, parent sync and independent
readback. Windows is a contract-test backend, not production durability
evidence.

`tools/relay_container_ring_transition_receipt_contract.mjs` is an independent
in-memory replay verifier for the same canonical schema and state machine. Both
implementations and the verifier tests are part of the 25-module signed release
closure.

This store is not yet joined to `PreparedControlPlane` or the CLI. It cannot
create a claim, restore a permit, send a deployment, or advance Authority
state. The next driver must load one fixed signed execution activation, append
receipt evidence at each network boundary, and keep restarted inflight claims
readback-only. Until the Linux fault campaign, installed-chain independent
verification, external head anchor, ACL/retention evidence and remote gates
pass, `--execute` remains fail-closed and production remains **NO-GO**.

## Signed Execution Activation Boundary

The runner now requires a second installed authorization after publication
verification and before credential loading. Its sole path is:

```text
<installation-root>/
  execution-activations/
    <publication-manifest-sha>.execution-activation.json
```

The runner derives the filename from the verified publication identity. The
API accepts verified bytes and an installation root, not a caller-selected
target, authorization ID, service, origin, path or overwrite flag. A
publication therefore has one immutable execution activation; a different
authorization requires a separately signed publication.

The activation record is bounded strict canonical JSON with recursive
duplicate-key and unknown-field rejection. It binds:

- publication manifest/packet, generation, activation sequence, runner build
  and runner trust-config digests;
- a fixed `POST` to the compiled private Authority claim endpoint, with Access
  service token required, no retry, fixed timeout and response ceiling;
- the permit Ed25519 SPKI and its compiled fingerprint;
- the complete canonical Authority claim and recomputed claim digest; and
- a domain-separated signed permit over authorization, claim digest, owner,
  ledger, claim credential and bounded issue/expiry times.

The claim must also match compiled transition/authorization policy digests,
account and ledger, pairwise-separated read/claim/deploy credential IDs,
Controller/Edge services, runner artifact and trust config. The release key
and claim-permit key must be distinct. Credential loading subsequently proves
the same account and credential identities; the verified activation identity
is retained by `PreparedControlPlane` for the future claim/receipt driver.

The authorization typestate is:

```text
Verified publication
  -> Verified installed execution activation
  -> Loaded credentials
  -> Read/deploy/claim identity proof and Authority preflight
  -> PreparedControlPlane
```

No execution entry point can construct the later states from raw IDs. The
checked-in release, activation and credential trust objects remain disabled,
so the current CLI still exits before credential or network access.

Activation installation is create-new. Same-directory staging is published to
the fixed target with no-replace behavior, followed by directory sync and
independent exact-byte/digest readback. An existing exact file is an
idempotent replay. Different, partial, linked, noncanonical or
publication-drifted content is a hard conflict and is never overwritten. A
possibly published result that cannot be confirmed is
`durability_unknown`; recovery rereads only the fixed path.

The signed source closure is 28 modules, adding the Rust activation
module, independent JavaScript activation verifier and verifier tests to the
prior 25-module closure. Both collectors and both release verifiers agree on
the inventory. The merged local gates observed 76 runner library tests, one
runner binary test, two runner CLI tests, 38 runner JavaScript tests and 65
broader ring-transition tests.

Remaining P0 is live Authority claim creation, typed T1 and Edge phases, live
receipt append around every network operation, the public library-owned
resumable driver, Linux adversarial/concurrency/power-loss tests, full
four-approval revalidation, an external receipt-chain anchor, and the
exposed-credential revocation gate. No remote action was performed and
production remains **NO-GO**.

## At-Most-Once Claim Dispatch And Exact Recovery

The native runner now implements the local claim-create boundary without
enabling checked-in trust or performing a remote request.

`PreparedControlPlane::create_claim_once(self)` is a consuming operation. It
first publishes a create-new, read-only dispatch guard at:

```text
execution-activations/<publication-manifest-sha>.claim-dispatch.json
```

The guard binds the activation, publication sequence, authorization, claim,
owner, frozen request digest, POST request-ID digest, and reservation time.
Only the first process that durably creates and reads back the exact record
receives the in-memory POST capability. Every later process observes the
guard and skips directly to exact GET. Uncertain persistence authorizes
nothing.

The guarantee is at-most-once authorization, not exactly-once delivery. A
crash between guard durability and socket write can produce zero POSTs. That
case remains GET-only and requires a new reviewed publication to regain send
authority.

The claim POST has one fixed path, body, response bound, timeout, HMAC
credential, and Access workload identity. It is never retried. Only
`201/created` and `200/exact_replay` with an exact initial claim state are
accepted. Malformed or identity-drifted success, redirects, timeout-like
statuses, `409`, throttling, all `5xx`, transport loss, and explicit
`outcome_unknown` are ambiguous and transition only to exact GET.

POST success is not enough. The runner always performs an exact GET with a new
request ID and accepts only a fully verified Authority snapshot. The resulting
types are:

```text
ClaimedControlPlane
  snapshot + Created | ExactReplay | RecoveredAfterAmbiguous

ClaimRecoveryControlPlane
  last error + prior classification + recover_exact_claim(self)
```

The recovery type has no POST, append, deployment, or observation method.
Only the claimed type owns later capabilities, and its append, deploy, and
observation paths bind the current authorization ID and claim digest.

The dispatch schema has an independent verifier in the existing signed
execution-activation JavaScript module. The signed source closure remains 28
modules. Local evidence is 82 Rust library tests, one binary test, two CLI
tests, strict all-target Clippy, 39 runner JavaScript tests with 146
expectations, and 65 broader ring-transition tests with 728 expectations. The
complete repository `bun run check` passed in 719.5 seconds.

Remaining P0 starts with typed T1 and Edge-previous phases, live receipt
integration, and the resumable driver, followed by exact Linux crash,
concurrency, ACL, sync and power-loss evidence, full approval revalidation,
external receipt anchoring, isolated staging proof, and exposed-credential
revocation. Go/VPS remains authoritative and production remains **NO-GO**.

## Typed Stable Baseline Readback

The native runner now owns the authenticated T1 and Edge-previous baseline
boundaries. They are separate sealed phase types and accept only the exact
Authority state/history from which that phase is legal. Raw phase names or
caller-selected service/version values cannot create a capability.

Each prepared phase is snapshot-owned. It freezes the claim identities,
Authority version, previous service/version/deployment set, observation
window, claim validity window, canonical evidence identity, and exact append
binding. The transport performs four ordered read-only Cloudflare requests:

```text
deployment set A -> version detail A -> stable wait
                 -> deployment set B -> version detail B
```

Both normalized observations must be identical and equal the signed previous
baseline. Drift is recorded through the phase's fail-closed Authority
outcome: T1 becomes `aborted`; Edge-previous becomes `recovery_required`.
Neither classification creates a deployment permit.

The runner rechecks the clock and claim expiry after the wait and before the
POST. Expiry or clock rollback sends no append. The one append accepts only
`201/step_appended` or `200/step_replayed`. Malformed or mismatched `2xx`,
redirects, timeout-like responses, throttling, `5xx`, transport loss, and
`outcome_unknown` are ambiguous and are never reposted.

Accepted and ambiguous append outcomes both require one new exact Authority
GET. `record_t1_readback(self)` and
`record_edge_previous_readback(self)` consume the old
`ClaimedControlPlane`; only a GET-verified snapshot containing the exact step
is returned. A prior or unverifiable snapshot drops the stale capability and
requires restart-time exact recovery.

The canonical evidence contract is
`cinatoken-ring-transition-runner-stable-baseline-readback-evidence-v1`.
Independent JavaScript verifies the frozen Rust T1 step digest
`7af14e9d7761d3d665d5fbe5ae425cb407b33730b40567867c70410a580c859b`.

Local evidence is 91 Rust library tests, one binary test, two CLI tests,
strict all-target Clippy, 39 runner JavaScript tests with 146 expectations,
and 66 broader ring-transition tests with 729 expectations. The complete
repository `bun run check` passed with exit code 0 in 747 seconds, including
859 Worker tests and 71 frontend tests. Checked-in trust remains disabled and
no credential or remote API was used.

Remaining P0 starts with live create-new receipt append at every network and
recovery boundary, then the resumable one-action `execute_current()` driver.
The older mutation-intent and post-observation append paths must also adopt
the same strict response/ambiguous exact-GET model before staging. Linux
crash/power-loss proof, approval revalidation, external receipt anchoring,
credential revocation, isolated staging, and G1-G8 remain open. Production is
**NO-GO**.

## Incremental Authority Receipt Prefix

The runner now joins exact Authority claim readback to the existing Execution
Receipt V1 store. A verified `claimed/0` snapshot projects the genesis
receipt; each later nonterminal exact snapshot projects the same genesis plus
its complete ordered Authority step/expiry history. A terminal snapshot adds
the existing terminal seal. Existing terminal canonical vectors are
unchanged.

The public distinction is intentional:

- `install_snapshot_plan` and `verify_prefix` accept a valid unsealed or
  sealed prefix;
- `install_terminal_plan` and `verify` still require a terminal seal; and
- terminal Authority status without the seal is invalid in Rust and the
  independent JavaScript verifier.

Every shared `read_exact_claim_at` first validates the bounded authenticated
response and complete Authority snapshot, then joins publication and
credential identities, installs and independently reads back the canonical
prefix, and only then returns the snapshot. A receipt planning, conflict,
filesystem, or durability error returns no control-plane capability.

Prefix extension is create-new. Exact old slots replay, only the missing
suffix is created, a stale shorter snapshot conflicts with a longer durable
prefix, and different bytes at an existing sequence fail closed. Eight
concurrent same-genesis writers produce one create and exact replays only.
The Windows staging-file retry is bounded contract-test accommodation; it is
not Linux durability proof.

`verifyRingTransitionExecutionReceiptPrefix` independently checks canonical
bytes, links, shared identities, semantic digests, state progression and
terminal/seal coupling. The frozen T1 prefix head is
`058f4e27874bbab0243a81178ba41187cc981c43de43fce2fc70ec5a5667a1c5`.

Focused and aggregate gates pass with 95 Rust library tests, one binary test,
two CLI tests, 13 focused JavaScript receipt tests/32 expectations, 40 runner
JavaScript tests/150 expectations, and 66 broader ring-transition tests/729
expectations. Both release descriptions retain the fixed 28-module closure.
The complete repository gate passed in 694.2 seconds with 859 Worker tests,
71 frontend tests, required WASM checks, and zero frontend redaction or budget
findings. Checked-in trust remains disabled and no credential or remote API
was used.

The prefix records observed Authority truth; it does not authorize or prove
the start of an external operation. Remaining P0 begins with durable
request-start and request-finish/ambiguous receipts around every mutation and
readback boundary, followed by the one-action resumable driver, remaining
append-path recovery, Linux crash/power-loss proof, approval revalidation,
external anchoring, isolated staging and credential revocation. Go/VPS
remains authoritative and production remains **NO-GO**.

## Mutation Operation Receipt Gate

The runner now wraps every current Authority and Cloudflare mutation with a
durable Operation Receipt V1 gate. The production control-plane path always
constructs `PersistentReceiptRecorder`; no-op recorders exist only inside
tests.

Before `HttpExchange::send`, the runner:

1. validates and freezes the exact target and body;
2. derives an operation ID from activation, authorization, claim, operation
   kind, state version, fixed `POST`, target digest and request digest;
3. publishes and independently reads back a create-new `request_started`
   record; and
4. sends only when publication returns `Fresh`.

An existing unfinished operation is sealed ambiguous and returns without
network I/O. An existing finished operation also returns without network
I/O. Accepted, rejected and ambiguous finishes are fixed slot 2 records
linked to the start SHA-256. The first persisted finish is terminal; later
responses cannot overwrite it.

The covered writes are claim creation, all Authority step appends, Controller
deployment and Edge deployment. Claim recovery performs exact GET only.
Authority append recovery requires exact GET containing the expected step.
Cloudflare deployment recovery proceeds through the existing stable
readback. None can recreate a mutation capability from a receipt.

The storage layout is fixed:

```text
execution-operation-receipts/
  <authorization-sha256>/
    <operation-sha256>/
      00000000000000000001.operation.json
      00000000000000000002.operation.json
```

Only canonical regular create-new files are accepted. Gaps, unknown names,
links, a third slot, context drift, operation drift, predecessor mismatch,
time reversal or conflicting bytes fail closed. Recovery does not create a
missing start record.

The records bind release, publication, activation, claim, ledger, account,
credential identities, permit/trust identities and service names. They store
request/response digests, never raw headers, secrets, tokens or bodies.

The independent JavaScript verifier recomputes the operation ID and validates
one-record unfinished and two-record terminal chains. Rust and JavaScript
agree on the frozen operation, start and accepted-finish digests. Local gates
pass with 101 Rust library tests, strict Clippy, 19 focused receipt tests/51
expectations, 46 runner JavaScript tests/169 expectations and 66 broader
ring-transition tests/729 expectations. The complete repository
`bun run check` also passes with exit code 0 in 675.6 seconds.

This is at-most-once send authorization, not exactly-once provider execution.
Remaining P0 is the library-owned one-action resumable driver, explicit
read-only request-boundary receipts, terminal operation-head anchoring,
exact Linux crash/durability campaigns, approval revalidation, isolated
staging, credential revocation and G1-G8. Checked-in trust remains disabled;
Go/VPS remains authoritative and production remains **NO-GO**.

## Library-Owned Single-Action Resume Driver

`cinatoken_ring_transition_runner::execute_current()` is now the sole public
library reducer entry. It calls `authorize_execution()` on every invocation,
so release, publication, activation, credentials, operation chains, receipt
prefix and exact Authority state are never trusted from prior process memory.

Before credential proof traffic, the runner enumerates and verifies the fixed
operation-receipt subtree for the current authorization. Unknown or linked
entries, context drift, malformed chains, more than 128 operations, gaps or
noncanonical content stop execution. After credential proof, every discovered
unfinished start is finished ambiguous and the directory is re-audited. An
absent start is never created by recovery.

The reducer maps the exact snapshot to one action:

```text
claimed -> T1 stable baseline
t1_verified -> fresh Controller intent + one deployment
controller_inflight -> stable readback + Authority observation
controller_verified -> Edge previous baseline
edge_prechecked -> fresh Edge intent + one deployment
edge_inflight -> stable readback + Authority observation
expired/wait -> no network
terminal -> verified sealed prefix, no mutation
```

A newly posted claim stops at `claim_established`. An ambiguous Authority
append stops at `authority_append_recovery_pending`. Restored inflight states
never receive a deployment permit. The only deployment permit is the private
nonserializable value returned by an exact fresh Authority intent append in
the same process.

One reducer action may include one Authority CAS and one Cloudflare deployment
POST; it never includes two reductions, a deployment retry or caller-selected
continuation. The returned `ExecuteCurrentOutcome` contains only action,
authorization digest, status/version, claim classification and redacted
transport classification.

Local gates pass with 105 Rust library tests, one binary test, two CLI tests,
strict Clippy, 46 runner JavaScript tests/169 expectations and 66 broader
ring-transition tests/729 expectations. The complete repository
`bun run check` passes with exit code 0 in 639.9 seconds. The fixed source
closure remains 28 modules. Checked-in trust and CLI execution remain
disabled.

Remaining P0 is read-only request receipt coverage, terminal operation-head
and external anchoring, exact Linux process/power-loss/ACL proof, the DO shard
supervisor and disposable Container adapter, replacement-credential isolated
staging, remaining Go compatibility, revocation and G1-G8. Go/VPS remains
authoritative and production remains **NO-GO**.

## Read-Only Operation Receipt Gate

The native runner now places every current Authority and Cloudflare GET behind
Operation Receipt V1. This supersedes the prior "read-only request receipt
coverage" gap and the old 16-chain audit limit. It does not supersede exact
Authority/stable-readback semantics or the external-anchor gap.

| Kind | State versions | Start after expiry |
| --- | --- | --- |
| `authority_claim_read` | `0` | through expiry + 600 seconds |
| `authority_preflight_read` | `0` | through expiry + 600 seconds |
| `cloudflare_token_verify_read` | `0` | through expiry + 600 seconds |
| `cloudflare_deploy_token_verify_read` | `0` | through expiry + 600 seconds |
| `cloudflare_deployment_read` | `1`, `3`, `4`, `6` | never |
| `cloudflare_version_read` | `1`, `3`, `4`, `6` | never |

Each GET hashes its absolute HTTPS URI and a fresh runner-local request nonce
under `cinatoken-ring-transition-runner-read-operation-request-v1`. That
digest enters the existing activation/authorization/claim-bound operation ID.
The request-start event repeats the nonce digest. A changed target, nonce,
method, kind, state or request digest therefore fails independent replay even
when the operation ID is recomputed.

The read-token and deploy-token identity checks use separate operation kinds.
The receipt still stores no credential, header or body; the nonce is local and
does not prove remote receipt. Operation timestamps are whole-second local
audit values and do not measure request latency.

The two-slot transition is fixed:

```text
absent
  -> create-new request_started + exact readback
  -> exactly one HTTPS GET
  -> first linked request_finished wins
```

An existing unfinished start is finished ambiguous with zero network. An
existing terminal chain also performs zero network. The response categories
are:

| Receipt outcome | Read classification |
| --- | --- |
| `accepted` | expected bounded `200`; exact claim additionally passed exact semantic verification |
| `rejected` | deterministic client rejection other than `408`, `425`, `429` |
| `ambiguous` | exchange loss, redirect, unexpected success, `408`, `425`, `429`, `5xx`, malformed or identity-drifting response |

`accepted` is transport evidence, not state authority. Token verification and
Cloudflare observation bodies still pass their dedicated semantic verifiers;
only exact Authority snapshots and stable-readback evidence select reducer
state.

The per-authorization operation tree has 128 fixed create-new capacity-marker
slots. A marker canonically binds its slot and operation ID. It uses the same
same-directory synced staging, no-replace publication, parent sync and exact
readback discipline as receipts before the operation directory or slot 1 is
created. Interrupted staging is ignored as non-authorizing. The 129th
concurrent contender cannot publish a marker, persists no operation
directory/start and cannot reach network I/O. A crash may strand a complete
marker before slot 1; audit treats it as consumed non-authorizing capacity and
creates no receipt or send capability. If the operation directory was already
created, audit accepts only the empty-or-staging-only form and still creates no
finish or send; the exact operation may later resume normal slot-1
publication. Markers and historical evidence are never deleted or reused.
Exhaustion requires a new authorization. The nominal fault-free lifecycle
estimate is about 59 chains.

Rust and JavaScript share frozen read-request, operation-ID and request-start
vectors. Adversarial coverage includes recomputed-ID request drift, method and
state drift, exact and late recovery boundaries, disallowed post-expiry
Cloudflare reads, absolute-origin binding, separate credential classes,
`408/425/429`, kind-specific accepted/rejected statuses, transport loss,
collision with zero sends, marker-backed empty-directory recovery and the
129th reservation.

The JavaScript verifier declares
`verificationScope=single_operation_chain`,
`aggregateCapacityVerified=false` and
`absoluteHttpsTargetVerified=false`. It verifies the supplied chain's internal
target digest binding, not the URI that originally produced the digest or the
authorization directory's aggregate marker set. Rust transport enforces the
absolute HTTPS URI before hashing; Rust authorization audit enforces the 128
marker bound.

Internal links cannot detect whole-chain replacement by a writer that controls
the operation directory. The following section records the now-implemented
local aggregate/candidate binding without changing Execution Receipt V1.
Remaining K7 is independent signed/WORM anchoring, dirfd-pinned Linux
crash/path/sync/ACL/power-loss evidence and isolated staging proof. Checked-in
trust remains disabled; Go/VPS remains authoritative and production remains
**NO-GO**.

## K7 Aggregate Local Closure Contract

This section supersedes the preceding shorthand "into the terminal seal."
Execution Receipt V1 is frozen byte-for-byte. No operation data is added to its
schema or terminal receipt. The join is expressed by an immutable
`OperationHeadSetV1` plus an immutable `OperationHeadLocalSealV1`. The latter
binds the frozen execution terminal head to the former. This is a required
runner contract and does not assert that the implementation or Linux
acceptance campaign is complete.

A third immutable local object, `TerminalSnapshotCandidateV1`, closes the
accepted-terminal-GET crash window. It is durably published before the
accepted operation finish and binds the canonical verified terminal snapshot,
snapshot digest/length, exact GET operation/start receipt, HTTP `200`,
response-body and optional response-ID digests, finish time, and expected
terminal Execution Receipt head/count. It is retained evidence and an
admission barrier, not an alternate Authority state or external anchor.

### Canonical OperationHeadSetV1

The runner projects one closed-schema canonical object from the complete
per-authorization capacity tree. The header binds:

- schema and contract version;
- environment, activation SHA-256, authorization ID SHA-256, claim digest and
  operation-context SHA-256;
- `capacityLimit=128`;
- `operationCount`, `capacityReservationCount` and `markerOnlyCount`; and
- entries sorted strictly by ascending marker slot.

Each published marker contributes exactly one entry:

| Chain state | Required entry fields | Forbidden fields |
| --- | --- | --- |
| `marker_only` | slot, marker-bound operation ID, `receiptCount=0` | start digest, head digest, outcome |
| `terminal` | slot, operation ID, start digest, `receiptCount=2`, terminal head, outcome | absent or nonterminal finish |

`entries.length == capacityReservationCount`,
`capacityReservationCount == operationCount + markerOnlyCount`, and the count
must not exceed 128. A complete marker with no start is retained as
`marker_only`; interrupted private staging is not an entry. An operation
directory without its matching marker, an unfinished start, duplicate or
missing slot, unknown published object, identity drift, gap or noncanonical
receipt is a conflict.

The exact canonical bytes are written to private same-directory staging,
verified, file-synced, published no-replace, parent-synced and read back. An
existing head set is exact replay only when every byte matches. Publication is
an admission barrier and permanently freezes the operation tree.

### Canonical OperationHeadLocalSealV1

The aggregate local seal repeats the environment, activation, authorization,
claim and operation-context identities and binds:

```text
executionReceiptHeadSha256
executionReceiptCount
terminalStatus
terminalStateVersion
operationHeadSetSha256
operationHeadSetBytes
operationCount
capacityReservationCount
markerOnlyCount
terminalSnapshotCandidateSha256
terminalSnapshotCandidateBytes
terminalCandidateOperationIdSha256
terminalCandidateStartReceiptSha256
```

The execution values must come from an exactly verified terminal Execution
Receipt V1 chain. The head-set digest, byte length and counts must come from
the exact independently read-back `OperationHeadSetV1`. The local seal uses
the same canonical create-new, sync, no-replace and readback protocol. Existing
different bytes are a conflict. Full terminal typestate is returned only when
the execution chain, head set and local seal all verify and all repeated
identities and values agree. The four candidate fields are either all `null`
or all populated. When populated, the candidate must still exist, its
operation/start pair must identify an `accepted` terminal head-set entry, and
its expected execution head/count and snapshot digest/length must match the
installed terminal chain. Deleting or replacing it invalidates the closure.
A candidate-less seal can remain structurally valid for older or non-claim
terminal history, but it is not production claim-read promotion evidence.
Execution Receipt V1 alone remains valid terminal history evidence but is not
full aggregate closure.

### Per-authorization flock protocol

The current Linux lock object is the opened authorization-directory inode. Its
contents are not evidence. The runner applies its current path/type checks and
takes exclusive `flock(LOCK_EX)` for every operation-tree or closure mutation:

1. reserve capacity and publish slot 1;
2. publish slot 2, including local ambiguous recovery;
3. install the terminal execution projection;
4. publish or exactly replay the operation head set; and
5. publish or exactly replay the aggregate local seal.

After lock acquisition the runner re-verifies all relevant durable state
before deciding an action. Reserve holds the lock through marker and start
publication, sync and readback, then releases it before the single network
exchange. Finish reacquires it and holds it through terminal publication and
readback. Closure takes the lock once and uses internal non-relocking
operations so no nested-lock assumption enters correctness.

The lock is a local concurrency linearization point, not a receipt, durable
permit, distributed lock or replacement for filesystem durability. Network
I/O while the lock is held is prohibited. The current implementation locks
the authorization-directory inode but later re-resolves some paths. It does
not yet pin trusted parent/authorization dirfds, verify UID/GID/mode/inode
continuity, or perform every scan/open/rename/fsync through contained
`openat2`/`*at` operations. Directory rename/replacement therefore remains a
production blocker. NFS or another filesystem with unreviewed
`flock`/rename/fsync semantics is **NO-GO**.

### Admission and recovery state machine

After loading and locally binding only the fixed activation-scoped credential
handles, every runner start performs local recovery before any remote identity
proof or Authority/Cloudflare request:

```text
acquire authorization flock
  -> verify paths, Execution Receipt V1 and complete operation tree
  -> verify or recover closure objects
  -> release flock
  -> only then, if no barrier exists, consider identity/network work
```

The admission barriers are:

- a committed terminal snapshot candidate, or indeterminate operation/closure
  staging residue;
- a terminally sealed Execution Receipt V1 chain; or
- a published `OperationHeadSetV1`.

Either barrier forbids a new marker, start, identity proof, credential proof or
network request. A sealed execution chain permits only local completion of
already published starts as `ambiguous`, head-set publication and local-seal
publication. A published head set permits no reserve or finish; when its local
seal is absent, recovery may only verify the frozen inputs and publish the
uniquely implied seal. Before normal identity/network work is allowed, startup
recovers the operation bound by a valid terminal candidate as its recorded
`accepted` finish, finishes other unfinished starts as `ambiguous`, installs
the candidate-implied terminal Execution Receipt chain and completes the
aggregate closure. No old send capability is restored.

| Durable crash point | Local recovery under flock | Authority/network effect |
| --- | --- | --- |
| Candidate/operation/closure staging without a committed target | Fail closed as indeterminate durability | None |
| Published marker, no start | Preserve as marker-only capacity | None |
| Published start, no finish | Append the first terminal `ambiguous` locally | None |
| Published terminal candidate, no finish | Append the candidate-bound `accepted` finish and seal locally | None |
| Published terminal finish | Reuse exact head | None |
| Published head set, no local seal | Verify exact set and publish implied seal | None |
| Published local seal | Verify and return full terminal typestate | None |
| Candidate missing or changed after local seal | Quarantine because candidate binding cannot verify | None |
| Process dies holding lock | Kernel releases lock; successor re-audits disk | No permit survives |
| Conflict, unsafe path or impossible count | Quarantine authorization | None |

Recovery never invents an absent start, reopens a terminal chain, restores a
send permit, deletes a marker, reuses a slot or changes an outcome. If exact
local convergence is impossible, the authorization is retained for audit and
a new authorization is required.

### Security boundary and remaining gates

The local seal detects omission, reordering and races relative to the locally
verified root, but cannot detect replacement of the entire execution chain,
operation tree, head set and seal by a privileged local writer. External
closure remains two independent future controls:

1. an independently operated DSSE signer signs the exact local-seal digest and
   immutable candidate identity; and
2. a provider WORM write/readback proves the anchored object identity,
   retention mode, retention deadline and deletion/overwrite resistance.

DSSE proves neither retention nor deletion resistance. WORM retention proves
neither signer identity nor approval. Both gates, plus independent
verification, key custody, provider policy readback and recovery evidence, must
pass separately.

The independent JavaScript verifier proves only canonical structure and
cross-binding of the supplied head-set/local-seal documents. It explicitly
does not prove the execution chain, context preimage, operation receipt heads,
marker completeness on disk, candidate content, filesystem completeness,
DSSE or WORM retention.

K7 local closure also requires mixed terminal/marker cross-runtime vectors;
two-process reserve/finish/closure contention; kill-after-every-sync tests;
fixed-path, symlink, hard-link, dirfd/inode, UID/GID/ACL and backup/restore
checks; and ext4/XFS power-loss evidence with zero identity/network calls
before local recovery. Published evidence is irreversible: rollback disables
the candidate, preserves every receipt and aggregate object, returns new work
to hot Go/VPS and uses a new authorization rather than editing history.

The audited cinaVibeSDK and cinatoken Go sources have no direct parity for
these aggregate objects, Linux `flock`, DSSE evidence or provider WORM
retention. Go/VPS remains the traffic, scheduler and financial authority.
Checked-in trust remains disabled and production remains **NO-GO**.

## Linux Single-Parent Publication Increment

The Linux create-new publication primitive now opens the immediate parent
directory once and retains that descriptor for the complete target decision:

```text
open parent directory once
-> reject unsafe existing target through openat(O_NOFOLLOW)
-> create staging through openat(O_CREAT|O_EXCL|O_NOFOLLOW)
-> write, exact readback, chmod 0444 and fsync staging
-> renameat2(same dirfd, RENAME_NOREPLACE)
-> fsync the same parent dirfd
-> reopen target through the same dirfd
-> compare target dev/inode/owner/group/mode/nlink with the staging inode
-> reopen the parent pathname and require the same directory identity
-> perform two bounded reads and return only exact bytes
```

This primitive is shared by Execution Receipt V1, Operation Receipt V1,
capacity markers, terminal candidates, operation head sets and local seals.
It rejects group/world-writable directories or files, foreign UID/GID,
non-directory parents, non-regular targets and final files with `nlink != 1`.
A competing target wins without overwrite; a different byte sequence remains
a conflict. Failure to prove the target or parent sync remains
`DurabilityUnknown`.

Linux-only tests inject a parent pathname replacement immediately after
staging fsync. The target must still appear only in the displaced original
directory inode, the newly created replacement directory must remain empty,
and publication must fail closed because the pathname no longer resolves to
the pinned inode. Additional tests retain a competing target and reject a
hard-linked target. The dedicated
`.github/workflows/ring-transition-runner-linux.yml` gate runs the full runner
library and warning-free clippy suite on Ubuntu 24.04.

Native evidence is frozen at commit
`0b8f50567d30d8c69e51982af44555879d7cf691`. GitHub Actions
[run 30142006553](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142006553)
passed formatting, all 127 Linux library tests and warning-free Clippy. The
clean commit-object collector reports 31 modules, 1501593 bytes and inventory
SHA-256
`26eea3d220a34d8c6538eedea55dbeca73de858f7965960db64b7c6523a4dac6`.

This closes the stage/rename/parent-fsync split for one publication, not the
entire K7 pathname boundary. Authorization `flock` acquisition and later tree
scans still accept paths rather than a `LockedAuthorization` fd graph.
Operation, execution-chain and closure directories are not yet all opened
with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)`.
Split-lock replacement, multi-process kill points, ACL checks, backup/restore
and ext4/XFS power-loss evidence therefore remain required.

The receipt store is evidence owned by the external release runner. It must
not be placed on a Cloudflare Container root filesystem. Cloudflare documents
that Container disk is ephemeral and is recreated after sleep/restart, while
the Container class is backed by a Durable Object that can retain associated
persistent state. Runtime shard state belongs in DO storage/D1/R2; immutable
release evidence belongs in the reviewed external Linux store and future
DSSE/WORM anchor. See the official
[Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
boundary.

## Linux Authorization Lock Capability Increment

Linux authorization transactions now use `LockedAuthorization`, which owns
the retained `operation-receipts` parent descriptor, the authorization
descriptor opened relative to that parent, stable filesystem identities and
both exclusive `flock` domains. Acquisition order is fixed:

```text
open and validate operation-receipts parent
-> flock parent exclusively
-> revalidate parent pathname attachment
-> open authorization child with openat(O_DIRECTORY|O_NOFOLLOW)
-> validate and flock authorization exclusively
-> require parent-relative and absolute authorization identity agreement
```

The parent lock prevents cooperating processes from splitting onto old and
replacement authorization inodes. It protects only local control-plane
publication and is released before any HTTP exchange. Reserve, finish,
unfinished-operation recovery and terminal closure receive the typed
capability and call `require_bound()` before and after the durable points that
could otherwise lead to fresh send authority or terminal success.

Linux-only tests now also replace the authorization pathname after lock
acquisition and require fail-closed rejection, and prove that a competing
parent `flock` remains blocked while `LockedAuthorization` is alive. Commit
`63df95c6f8390579e00b2788378abdb89eb5f3c5` passed
[Ubuntu run 30142822377](https://github.com/cinagroup/cinatoken-rust/actions/runs/30142822377)
with formatting, 129 Linux library tests and warning-free Clippy. The clean
31-module inventory contains 1509783 bytes and has SHA-256
`8fd60cc8c0849f89ace289d6eb6b099f11f8a061d1226708185e946aa872d971`.

This is not the final pathname boundary. Root, execution-chain, per-operation
and closure traversal still contains path-based work that must move behind
retained descriptors and reviewed `openat2` containment. A hostile same-UID
writer can still force fail-closed quarantine or ambiguous residue at those
remaining sites. Multi-process process-death/rename campaigns, syscall-trace
proof, ACLs, backup/restore, ext4/XFS power-loss and external DSSE/WORM
anchoring remain required. The external Linux runner remains the receipt
owner; Cloudflare Container disk remains replaceable scratch. Production
remains **NO-GO**.

## Linux openat2 Child-Containment Increment

All Linux child opens that already have an immediate parent descriptor now use
one fail-closed `open_linux_beneath` primitive. The wrapper calls
`SYS_openat2` with:

```text
RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV
```

Authorization child directories retain `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`.
Staging creation retains `O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW|O_CLOEXEC` and mode
`0600`; stable target readback retains `O_RDONLY|O_NOFOLLOW|O_CLOEXEC`. The
file is later changed to `0444`, synced and identity-checked by the existing
publication protocol.

The `open_how` ABI is zero-initialized before its known fields are assigned,
so any future kernel tail fields remain zero. `ENOSYS`, resolve-policy denial
or any other `openat2` failure is returned to the caller; there is no fallback
to weaker traversal. A Linux-only test confirms one valid child and rejects a
parent escape plus a symlink child.

Commit `7c015f812ca42b73388166abd67b24da4d7cb6ae` passed
[Ubuntu run 30143505878](https://github.com/cinagroup/cinatoken-rust/actions/runs/30143505878)
with formatting, 130 Linux library tests and warning-free Clippy. The clean
31-module inventory contains 1511043 bytes and has SHA-256
`86fa2af05728e11ed6d338e8dfb727489de1a821b38c10626042b735e0250be7`.

This primitive does not itself retain every parent in the receipt graph.
Reserve, finish, recovery and closure still contain path-based acquisition,
enumeration, chmod or fsync sites above the child-open layer. Reserve-to-Fresh
descriptor continuity is the next P0 implementation unit, followed by the
remaining execution/closure graph and native multiprocess/fault campaign.
Production remains **NO-GO**.

## Linux Reserve Operation Dirfd Increment

Reserve now owns a `LockedOperationDirectory` from the retained authorization
descriptor through operation audit and start-receipt publication. Linux
capacity files use the authorization dirfd publication primitive. Operation
directories use `mkdirat`, are opened with the common fail-closed `openat2`
wrapper, and retain their path, parent-relative name and stable filesystem
identity.

Direct operation audit uses `fdopendir`/`readdir` on a duplicated descriptor.
The implementation first performs `lseek(fd, 0, SEEK_SET)` because duplicated
directory descriptors share the same open-file-description offset. Child
receipt opens, start append/readback, prefix verification, directory mode
transition and fsync all consume the retained operation descriptor.

`LockedOperationDirectory::require_bound()` verifies both the
authorization-relative operation entry and its absolute pathname against the
retained identity. Reserve invokes that check, together with
`LockedAuthorization::require_bound()`, before returning `Fresh`. A Linux
hook test replaces and recreates the operation pathname after descriptor
acquisition and proves that the transaction fails closed without publishing
to either redirected location. Another test proves consecutive descriptor
scans see the complete entry set.

Commit `8cf817f081d0001fc7ef1f6992984f990a1f8b50` passed
[Ubuntu run 30144317849](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144317849)
and
[job 89643177206](https://github.com/cinagroup/cinatoken-rust/actions/runs/30144317849/job/89643177206)
with formatting, 132 Linux library tests and warning-free Clippy. The local
aggregate runner gate passed 124 Rust library tests, 3 binary/CLI tests and 61
Bun tests with 242 expectations. The clean 31-module inventory contains
1534319 bytes and has SHA-256
`2f9d12f0893b65d88001f61becc08d92a95f818e1ca03849d8bd715f06f3f6f0`;
the source archive SHA-256 is
`ee1e9c865893fe01075e1baaa169f901b83d996ef27a2c3e3e99c4fe7cbbd781`.

The remaining P0 is the terminal barrier within reserve. Execution-chain,
head-set, closure and terminal-candidate paths are still re-resolved and are
not rechecked as one descriptor graph at the final `Fresh` boundary. Finish,
ambiguous recovery and terminal closure remain later graph-conversion slices.
Staging cleanup/error classification is tracked separately as P2. Real
multi-process replacement/kill, syscall-trace, filesystem-fault, DSSE/WORM
and Cloudflare lifecycle evidence remain mandatory. Production remains
**NO-GO**.

## Linux Reserve Terminal Descriptor Graph Increment

`LockedReserveTerminalBarrier` captures the authorization-specific terminal
admission topology from the installation root dirfd. Existing execution-chain
and closure directories retain their descriptors, parent-relative names,
paths, stable identities and content versions. Missing optional directories
remain explicit absence states and are rechecked. Shared roots bind only
object identity so another authorization cannot cause a false failure merely
by changing an unrelated child.

The Linux execution verifier scans the retained chain descriptor and opens
each receipt with `openat2`. Valid transient staging names remain accepted,
while unsafe staging objects fail closed. Head-set reads use
`LockedAuthorization`; local-seal and candidate reads use the retained
closure descriptor. The barrier keeps its existing ordered short circuit and
runs before reserve mutation plus immediately before any reservation result.

The final authorization audit now uses `fdopendir`/`readdir` on the retained
authorization descriptor. It directly validates capacity records, opens every
operation directory beneath that fd and verifies each sibling receipt chain.
This prevents a temporary replacement of the authorization pathname from
presenting a clean sibling tree to the final audit.

Commit `79b3f4a3e2534f3249c57e21f9314295d389105e` passed
[Ubuntu run 30147304951](https://github.com/cinagroup/cinatoken-rust/actions/runs/30147304951)
and
[job 89651524827](https://github.com/cinagroup/cinatoken-rust/actions/runs/30147304951/job/89651524827)
with formatting, 136 Linux library tests and warning-free Clippy. The local
aggregate runner gate passed 124 Rust library tests, 3 binary/CLI tests and 61
Bun tests with 242 expectations. Clean source evidence has Git tree
`85e4f7f267996c3d128a30bef6bfc17e1b3d780b`, archive SHA-256
`c0dd0f59f9582f9c18b20271f851c67a104341abaad36ae15fe02a3b7a851dd5`
and 31 modules totaling 1569772 bytes with inventory SHA-256
`51e2c990d72bf140588ffa175f73600abbd4b6ffa4319a0ef0f9e63d674f8890`.

Linux tests replace and recreate the execution chain and closure directory
after capture, introduce a head set before start publication, and verify
execution-staging parity. None can produce `Fresh`. The first pushed candidate
failed only because the new Linux test helper duplicated an existing
conditional fixture name; the passing candidate contains the rename.

The guarantee is bounded by kernel-enforced ownership. A process already
running as the runner UID can ignore advisory `flock` and keep terminal names
hidden across both checks. Production therefore requires a dedicated service
UID/GID, exact ACL/parent ownership and mount/workload isolation. Finish,
recovery, candidate installation and closure graph conversion, native fault
campaigns, DSSE/WORM and Cloudflare lifecycle evidence remain open.
Production remains **NO-GO**.

## Linux Finish and Recovery Retained Graph Increment

Finish now opens the operation directory beneath `LockedAuthorization` and
retains that descriptor through direct verification, finish publication,
readback and final binding checks. `finish_unresolved_operation` performs its
optional lookup only after the authorization is locked, so an absent or
terminal result is no longer derived from an unlocked replacement pathname.

`OperationFinishExpectation` separates ordinary first-terminal-wins behavior
from exact candidate behavior. Exact candidate finish verifies the candidate
start-receipt digest and compares the complete canonical sequence-2 receipt.
This prevents an existing but semantically different `Accepted` response from
being treated as the terminal snapshot response.

Recovery retains a `LockedVerifiedOperation` for every audited chain. The
initial audit, candidate decision, append, retained-object recheck and final
authorization rescan remain in one authorization lock domain. The final scan
must contain the same sorted operation IDs, all terminal, and the candidate
must still have identical canonical bytes.

Linux tests replace an operation pathname after finish verification and after
recovery graph capture. Both fail closed and neither the replacement nor the
displaced inode receives a finish receipt. Cross-platform tests reject a
candidate after start-receipt drift and reject a different existing accepted
finish.

Commit `33bbda404a01ae2b2e068237f891a44a1a3b8a68` passed
[Ubuntu run 30148796402](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148796402)
and
[job 89655504013](https://github.com/cinagroup/cinatoken-rust/actions/runs/30148796402/job/89655504013)
with formatting, 140 Linux library tests and warning-free Clippy. The local
aggregate gate passed 126 Rust library tests, 3 binary/CLI tests and 61 Bun
tests with 242 expectations. Clean source evidence has Git tree
`34947264d0812d4faefd1d7006bf577463bcaefd`, archive SHA-256
`5741487d63c7e710d0469dc3d8a8741c9c7c5521cb7d97eb08e625f30d290aea`
and 31 modules totaling 1591919 bytes with inventory SHA-256
`637906e8da2927e55467134368f584b6ffb500dce553efb650086f9bea2d7b5a`.

The remaining descriptor unit begins before these consumers:
terminal-candidate publication, terminal execution/head-set/local-seal
publication, closure recovery and closure verification still contain
path-based acquisition or publication segments. The initial trusted-root
acquisition and a hostile same-UID writer also remain OS-enforced boundaries.
Dedicated identity and ACL/mount isolation, native fault campaigns,
DSSE/WORM and Cloudflare lifecycle evidence remain required. Production
remains **NO-GO**.
