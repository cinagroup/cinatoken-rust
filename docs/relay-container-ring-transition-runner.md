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
