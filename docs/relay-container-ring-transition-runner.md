# Relay Container Ring Transition Runner

## Decision

The staging ring transition is executed only by a compiled Rust launcher whose
release identity is embedded at build time. The checked-in launcher is
permanently disabled and cannot be enabled by argv, environment, a writable
checkout, or a caller-selected trust file.

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
credential, origin, or force argument. Its checked-in embedded release has
`enabled=false` and null release pins. `--execute` therefore fails before
reading credentials or using the network even when poison environment values
attempt to enable or replace trust.

The embedded release contract reserves exact fields for:

- source commit and Git tree;
- source archive, `Cargo.lock`, `bun.lock`, and `package.json` digests;
- runner build, final bundle, and two-build reproducibility digests;
- trust config, release evidence, release policy, and release-key SPKI
  fingerprints;
- exact Authority origin and Worker version; and
- exact permit SPKI fingerprint.

These fields are structural reservations, not published evidence. A future
signed release builder must populate and verify all of them before producing an
enabled launcher.

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
| Deploy | account token verify; one exact pinned Controller or Edge deployment POST | upload, force, delete, secret/binding/resource mutation, second POST |

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

An enabled runner remains blocked until a separate release pipeline produces a
signed, create-new artifact packet outside the writable checkout. The packet
must contain:

1. strict canonical release manifest with no unknown fields;
2. exact Git commit/tree and clean source-archive digest;
3. lockfile, package, toolchain, target, build-argument, and fixed environment
   allowlist digests;
4. sorted module/file inventory with byte counts and SHA-256 digests;
5. two isolated builds with identical normalized artifact digest;
6. Node, Rust, Workerd, fault, security, and no-secret test evidence bound to
   that artifact;
7. exact Authority origin/version and permit SPKI fingerprint;
8. release policy and independent Ed25519 release-key fingerprint; and
9. DSSE signature with issue/expiry bounds and keys distinct from transition,
   authorization, HMAC, and Cloudflare credentials.

The final artifact must be installed by digest outside the source checkout.
The production launcher verifies the embedded release identity before reading
the four runtime handles.

## Remaining execution state machine

The next code boundary is the Rust-owned resumable orchestrator:

1. verify the signed transition, authorization, permit, and embedded release;
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
