# Relay Container Ring Transition Runner

## Decision

The staging ring transition is executed only by a compiled Rust launcher whose
release-policy digest, release-key fingerprint, fixed sidecar names, and
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
- exact release-policy SHA-256;
- independent release-key SPKI SHA-256; and
- exact staging Authority origin.

Commit/tree/archive/lock/module/build/evidence/Authority-version/permit-SPKI
identities live in the DSSE-signed manifest. A production launcher will verify
the fixed policy and packet against the compiled anchors, then hash its current
executable and compare it to the signed artifact identity.

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
The production launcher verifies compiled pins, fixed sidecars, DSSE,
manifest, current executable and publication receipt before reading the four
runtime handles.

## Remaining execution state machine

The next code boundary is the Rust-owned resumable orchestrator:

1. verify the fixed policy/packet, DSSE, current executable, signed transition,
   authorization and permit;
2. verify all three credentials and claim once;
3. read the exact claim on every start and derive the only legal next action;
4. persist Controller intent before one deployment POST;
5. perform two stable authenticated readbacks and append verified or recovery
   evidence;
6. repeat the same intent/one-POST/readback sequence for Edge; and
7. seal a create-new, hash-chained redacted receipt.

Crash injection is required at every network and evidence boundary. Restart
from either inflight state is readback-only and can never schedule another
deployment POST under the same authorization.

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
