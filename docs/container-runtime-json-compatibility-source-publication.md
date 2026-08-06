# Container Runtime JSON Compatibility C4 Source Publication

Status: local contract, CLI, Worker and Workerd/R2 foundation. No remote
Cloudflare object, Worker version, managed key or ceremony evidence is claimed.
Production remains **NO-GO**.

## Boundary

C4 turns already closed C1/C2 source evidence into the exact retrieval object
consumed by the private Source Verifier. It does not replace the external WORM
archive, authorize a deployment mutation, provision D1, or transfer traffic
from Go/VPS.

The capability split is:

```text
credential-free evidence assembly
  -> isolated offline C4 Ed25519 signer
  -> owner-approved transition and final source-authentication request
  -> credential-free canonical publication packet
  -> private Source Publisher: one conditional R2 put, no read path
  -> private Source Verifier: head/get, full C2/C4 replay, no write path
  -> independent publication readback receipt
```

The Source Publisher and Source Verifier are separate Worker deployments with
inert default exports, named RPC entrypoints, no routes, no workers.dev URL and
no preview URL. Both deployment configurations are default-off. The Publisher
has no signing key or Cloudflare account API credential. The Verifier cannot
call R2 write/list/delete APIs.

An R2 Worker binding is not operation-scoped IAM. The separate deployments and
static no-read/no-write implementations are meaningful blast-radius controls,
but do not prove platform-enforced per-method bucket permissions. Production
must additionally retain exact deployed source/version/config evidence, caller
Service Binding inventory, short enablement windows and account audit records.

## Digest DAG

The accepted order is deliberately acyclic:

```text
C1/C2 evidence roots
  -> C4 source-signature subject
  -> source-signature envelope E
  -> owner-approved transition containing sha256(E)
  -> final source-authentication request R
  -> canonical bundle B validated against R
  -> publication packet P = R + B + key/body/metadata identities
  -> optional unambiguous write receipt W
  -> independent readback request Q = sha256(P) + R + write outcome
  -> independent readback receipt X
```

The C4 subject signs the stable operation ID, plans, transition identity,
account/source roots, verifier policy and exact Verifier Version Metadata
identity. It intentionally excludes the envelope digest, owner-approved
transition digest, operation digest, publication packet, write receipt and
readback receipt. Adding those later values would create a digest cycle.

The owner approval binds `E`, and final bundle validation reconstructs the C4
subject from `R`. This makes the outer transition operation-specific without
asking an operator to fabricate placeholder digests in the production CLI.
Publication and readback receipts remain ceremony evidence and are never fed
back into the already published bundle.

## Offline Signer

`buildJsonCompatibilitySourceSigningIntent` freezes the stable pre-envelope
fields in a canonical intent contract. It contains no envelope, owner approval
or operation digest. The credential-free
`tools/assemble_container_runtime_json_compatibility_source_signature_subject.mjs`
requires independent intent, Verifier policy and Verifier identity digest
anchors, projects the subject with internal non-authorizing sentinels, and
writes one create-only canonical subject. Placeholder digests are never an
operator input.

`tools/sign_container_runtime_json_compatibility_source_bundle.mjs` accepts:

- one canonical source-signature subject;
- one canonical Source Verifier policy;
- the independently approved policy SHA-256;
- one bounded, non-TTY Ed25519 PKCS8 DER or PEM stream on stdin; and
- a path that must not exist.

It rejects key material in argv/environment, known Cloudflare/AWS credential
variables, noncanonical or concatenated key objects, a key outside the approved
current/previous trust slot, policy substitution and a previous-key signature
whose expiry exceeds its acceptance window. It derives the SPKI, signs under
the dedicated C4 domain, self-verifies and fsyncs one create-only canonical
envelope. It performs no network request and never persists the private key.

## Packet Assembly

`tools/assemble_container_runtime_json_compatibility_source_publication.mjs`
accepts canonical final request and bundle files plus independently approved
Verifier policy and Version identity digests. It replays the complete bundle
validator with a caller-frozen time, requires a usable signature window, and
writes one create-only canonical publication packet.

The packet binds:

- the exact source-authentication request and bundle v3;
- the envelope-derived fixed R2 key;
- the bundle contract digest and canonical body SHA-256/byte length;
- exact `application/json` HTTP metadata; and
- exact `contract`, `bundleSha256` and
  `sourceSignatureEnvelopeSha256` custom metadata.

## Atomic Publication

The private Publisher executes exactly one call:

```ts
bucket.put(key, body, {
  onlyIf: { etagDoesNotMatch: "*" },
  httpMetadata: { contentType: "application/json" },
  customMetadata,
  sha256: bodyDigest,
})
```

R2 returns `null` when the create condition fails. That is `occupied`, not an
authorization to overwrite or retry. An exception, malformed success response
or lost response is `ambiguous`; the Publisher issues no second `put`.
An unambiguous result produces a write-only receipt binding request, packet
object identities, returned version/ETag digests, Publisher Version Metadata,
one attempt, create-only behavior, zero retry and zero readback.

## Independent Readback

The Verifier readback RPC accepts a canonical ceremony request containing the
externally approved packet digest and exactly one write outcome:

- `published` requires the canonical write receipt; or
- `ambiguous` requires a null write receipt and is the only response-loss
  recovery path.

The Verifier independently performs `head` then `get`, rejects head/get drift,
reads the complete bounded canonical body, validates exact HTTP/custom
metadata, replays every bundle relationship, checks C4 signature/revocation
before and after crypto, and replays C2 signatures plus S3 closure. It rebuilds
`P` from the observed object and rejects a packet-digest mismatch.

For `published`, observed body/length/version/ETag and request/bundle/envelope
identities must exactly match `W`. For `ambiguous`, an exact object can be
recovered only by this independent path; the create call is still never sent
again. The receipt binds the readback request, packet, optional write receipt,
Publisher identity when known, Verifier service and Version Metadata identity,
all observed object digests, and explicit exact/independent facts.

## Required Production Order

1. Complete and independently replay C1, C2 and stable C3 evidence.
2. Freeze the C4 trust policy and external C2 policy anchor.
3. Deploy the Source Verifier dark with both gates false and independently
   read back its exact version, source, config, named exports, R2 binding,
   routes and caller inventory.
4. Derive the Verifier identity from that real Version Metadata ID and policy.
5. Deploy/read back the Publisher dark with both gates false and no signer key.
6. Run isolated C4 review and signing against the real Verifier identity.
7. Create the owner-approved transition, final request, bundle and packet.
8. Enable only the Publisher ceremony caller and write gate for one operation;
   retain the result, then disable it and independently prove it is disabled.
9. Enable Verifier readback, produce the exact readback receipt, and compare it
   offline with the approved packet and optional write receipt.
10. Re-read Verifier/Publisher versions, configs, routes and account-wide caller
    bindings before any D0 mutation path is enabled.

## Local Verification

```powershell
bun run check:container-runtime:json-compatibility-source-publisher
bun run check:container-runtime:json-compatibility-source-verifier
bun run check:container-runtime:json-compatibility-deployment-transition
```

These commands cover strict declarations, intent/subject projection,
stdin/create-only CLI contracts,
Node fault tests, generated type drift, TypeScript, local/staging Wrangler
dry-runs and real Workerd/R2 conditional-write/readback tests. They remain local
evidence. Real key custody, remote dark deployment, remote R2 version/ETag,
account audit records and two-person ceremony evidence remain mandatory.
