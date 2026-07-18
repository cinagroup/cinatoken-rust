# Container Provider Response Protocol V3

Date: 2026-07-18

Status: frozen local implementation contract. No deployment, provider traffic,
or production authority is granted by this document.

## Purpose

Protocol v3 carries one completed provider HTTP response from the private Rust
egress Worker to the Container Controller without confusing raw provider
evidence, interpreted client behavior, or financial success. It is scoped to
provider-response transport and does not change the operation protocol, status
v3, terminal-ack v2, or runtime protocol v1.

The source authorities are:

- Go cinaToken commit `73652508abc5cb09214dde02d51d69d1d1ccc703` for
  OpenAI-compatible response interpretation;
- the shared Rust `go-openai-response-v1` interpreter for the executable ABI;
- cinaVibeSDK commit `918e9748` for deterministic stateful identity, separate
  supervisor/executor lifecycle, and layered health patterns; and
- Cloudflare binding, Durable Object, Container, and R2 semantics for the
  deployment substrate.

## Scoped Version Boundary

- Execute path: `/internal/v3/provider-attempts/execute`
- Request header: `x-cinatoken-provider-egress-protocol: 3`
- Response content type:
  `application/vnd.cinatoken.provider-response.v3+json`
- Readiness protocol remains separately versioned. Operation protocol `1`,
  operation-status v3, and terminal-ack v2 retain their existing meanings.
- A v3 request requires the exact egress Worker version committed by readiness.
  An unknown, missing, v2, future, or mixed execution version fails closed.

Execution v2 remains readable only for disabled recovery of already persisted
legacy `container-results/v1` and usage-receipt rows. It cannot dispatch a new
provider request, enter canary, or create v3 artifacts after the v3 reader is
promoted.

## Outer HTTP Semantics

An egress Worker that receives and completely buffers a provider HTTP response
returns outer HTTP `200` plus a canonical v3 envelope, whether interpretation
is success, typed error, HTTP error, or invalid body. Provider status is an
envelope fact and is never used as the broker response status.

Credential, configuration, request-policy, redirect, timeout, transport,
bounded-read, and internal serialization failures return a non-200 synthetic
broker error with no v3 envelope. The Controller must never persist synthetic
broker bytes as provider evidence.

## Bounds And Encoding

- Raw provider body: `0..=4_194_304` decoded bytes.
- Client body: `2..=4_194_304` decoded bytes.
- Each canonical header JSON string: `2..=8_192` UTF-8 bytes.
- Canonical usage receipt JSON: `0..=8_192` decoded bytes.
- Complete envelope: at most `12_582_912` bytes.
- The active non-streaming P3 candidate is deliberately narrower: egress reads
  at most `1_048_576` provider-body bytes and Controller reads at most
  `3_200_000` envelope bytes. These are rollout limits, not a wire-format or
  storage-schema expansion.
- Binary fields use RFC 4648 base64url without padding. A decoder must reject
  padding, non-url alphabet, non-minimal encoding, and noncanonical replay.
- Body SHA-256 values cover decoded body bytes, not base64 text.
- Header SHA-256 values cover the exact UTF-8 bytes of `headers_json`.
- Lengths are decoded byte lengths and are verified before allocation.
- Every number is a non-negative JavaScript-safe integer unless a narrower
  field range is specified.

Raw body bytes may be invalid UTF-8. That is valid provider evidence and can
produce `invalid_body`; it is not an envelope parsing failure. Envelope and
header JSON bytes must be valid UTF-8.

## Canonical JSON

The envelope is compact UTF-8 JSON with no BOM, insignificant whitespace, or
trailing bytes. Object keys appear exactly in the order below. Header JSON keys
are lowercase and ascending by ASCII byte order. Duplicate, missing, unknown,
or reordered keys are rejected.

TypeScript must reject a UTF-8 BOM, parse with fatal UTF-8 decoding, validate
exact keys and types, regenerate the canonical object, and require exact input
text equality. Valid non-BOM UTF-8 has one canonical byte encoding, so this
retains byte-level strictness without allocating another envelope-sized byte
array.
This byte comparison rejects duplicate keys and order drift that `JSON.parse`
alone cannot detect.

```json
{
  "protocol_version": 3,
  "identity": {
    "operation_id": "...",
    "owner_generation": 2,
    "attempt_generation": 1,
    "provider_operation_id": "...",
    "request_sha256": "...",
    "egress_profile": "openai-chat-completions-canary-v1",
    "egress_worker_version_id": "..."
  },
  "interpretation": {
    "contract": "go-openai-response-v1",
    "source_commit": "73652508abc5cb09214dde02d51d69d1d1ccc703",
    "response_class": "success",
    "provider_status": 200,
    "client_status": 200,
    "audit_status": 200
  },
  "raw": {
    "content_type": "application/json",
    "headers_json": "{\"content-type\":\"application/json\"}",
    "headers_length": 35,
    "headers_sha256": "...",
    "body_length": 2,
    "body_sha256": "...",
    "body_base64": "e30",
    "provider_request_id": null,
    "completed_at": 1784313600000
  },
  "client": {
    "content_type": "application/json",
    "headers_json": "{\"cache-control\":\"no-store\",\"content-type\":\"application/json\"}",
    "headers_length": 62,
    "headers_sha256": "...",
    "body_length": 2,
    "body_sha256": "...",
    "body_same_as_raw": true,
    "body_base64": null
  },
  "usage_receipt": null,
  "provider_response_evidence_sha256": "...",
  "client_response_artifact_sha256": "..."
}
```

`response_class` is exactly one of `success`, `typed_error`, `http_error`, or
`invalid_body`. A success requires provider, client, and audit status `200`.
A typed error requires provider/client status `200`, audit status `500`, and no
usage receipt. HTTP error preserves provider status as client status and has no
usage receipt. Invalid body requires provider status `200`, client/audit status
`500`, and no usage receipt.

## Header Boundary

Raw evidence may record only safe observed values for:

- `content-language`
- `content-type`
- `openai-request-id`
- `request-id`
- `retry-after`
- `x-request-id`

`raw.content_type` is the exact observed media type or `null` when absent. The
raw header object may be empty; it must contain `content-type` exactly when the
field is non-null and must never synthesize an observed provider header.
R2 may use `application/octet-stream` as storage metadata when the observed
type is absent, but that fallback is not copied into raw evidence headers.

The interpreted OpenAI-compatible client artifact uses canonical
`application/json`. Success client headers contain the other safe observed
projection plus the canonical content type and
`cache-control: no-store`. Error client headers are exactly
`cache-control: no-store` and `content-type: application/json`. Authorization,
cookies, hop-by-hop fields, AI Gateway identifiers, Cloudflare internals, and
unapproved `x-cinatoken-*` fields never enter either artifact.

## Body Deduplication

`body_same_as_raw=true` requires identical raw/client decoded length and
SHA-256 and requires `client.body_base64=null`. Otherwise the client body is
mandatory, canonical base64url, and independently verified. Deduplication is a
wire optimization only: D1 always receives two records and R2 always receives
two create-only objects in separate namespaces. Exact success additionally
keeps the frozen receipt-v1 compatibility object under `container-results/v1`;
that third object is a byte-identical compatibility alias, not a third response
interpretation or authority. Its R2 HTTP/custom metadata and 0048 result row use
exact `application/json`, while raw evidence independently preserves the
observed provider content type.

## Attestation Digests

Both attestations use SHA-256 over compact canonical JSON with the field order
shown here and no digest field inside its own hash domain.

Provider evidence digest input:

```text
{"contract":"cinatoken-provider-evidence-attestation-v1","identity":<identity>,"interpretation":<interpretation>,"raw":{"content_type":...,"headers_length":...,"headers_sha256":...,"body_length":...,"body_sha256":...,"provider_request_id":...,"completed_at":...}}
```

Client artifact digest input:

```text
{"contract":"cinatoken-client-response-attestation-v1","identity":<identity>,"provider_response_evidence_sha256":"...","interpretation":<interpretation>,"client":{"content_type":...,"headers_length":...,"headers_sha256":...,"body_length":...,"body_sha256":...,"body_same_as_raw":...},"usage_receipt_sha256":null|"..."}
```

The digests attest identity and metadata. R2 independently verifies the body
checksum. TypeScript verifies Rust-produced attestations and never
reinterprets provider semantics.

## Durable Write Order

For one completed provider response, the Controller performs:

1. strict envelope verification;
2. create-only raw body write and exact R2 readback under
   `container-provider-evidence/v1/<operation>/<owner>/<attempt>/<raw-sha256>`;
3. append-only D1 raw evidence insert or exact replay;
4. create-only client body write and exact R2 readback under
   `container-client-artifacts/v1/<operation>/<owner>/<artifact-sha256>`;
5. for exact success only, create/replay the byte-identical receipt-v1
   compatibility result under `container-results/v1`, then insert/replay the
   exact usage receipt;
6. append-only D1 client artifact insert or exact replay, including its optional
   receipt foreign key;
7. for exact success, atomically attach the compatibility result and receipt
   digest to the DO operation/attempt;
8. DO-local artifact attachment with operation/owner/attempt generation fence;
9. one financial terminal decision, outbox event, and audit record; and
10. exact client delivery or durable replay.

This ordering is required by the already-frozen 0048/0052 foreign keys: a
success client artifact may reference receipt v1 only after that receipt and
its legacy result identity exist. Error classes never create either receipt or
legacy result. A later receipt protocol may remove this compatibility alias,
but P3 does not rewrite either historical schema.

Although the frozen envelope and DO schema retain a nullable success receipt for
future protocol compatibility, this P3 operational profile requires the exact
success receipt. Receipt-less success is rejected before raw R2 I/O and cannot
create a partial recovery state.

No crash boundary authorizes a provider resend. A raw-only or R2-only state is
inventory/reconciliation work, not financial or retry authority.

## DO And Runtime Terminal Shape

DO-local schema migration 3 separates provider status, client status,
classification, raw manifest, and client manifest.

- `succeeded`: exact ordinary 200, both artifacts, optional matching success
  receipt, and completed result.
- `interpreted_reject`: both artifacts, no success receipt/result, and client
  status may be 200 or non-200.
- `ambiguous`: no complete verified interpretation and no terminal artifact.
- `definite_reject`: frozen v2 history only.

The Linux runtime gains `Rejected`, carrying classification, provider/client
status, response code, and client artifact manifest. Provider `202` is never
success. Retry policy consumes raw classification, not rebuilt client status.

The Controller-to-Linux and Linux-to-DO operation boundary keeps runtime
protocol `1` but freezes outer status semantics for this additive outcome:
exact success is outer `200`, an interpreted provider rejection is outer
`422`, and incomplete/unknown execution is outer `202` with
`recovery_required`. The rejected payload adds exactly `classification`,
`provider_status`, `client_status`, and `client_artifact`; all four are present
or all four are absent for a legacy infrastructure rejection. The client
artifact manifest contains `object_key`, `object_version`,
`client_response_artifact_sha256`, body `sha256`, decoded `size`, and canonical
`application/json` content type. The object key must equal
`container-client-artifacts/v1/<operation>/<owner>/<artifact-sha256>`.

Migration 0052 is evidence storage, not this terminal implementation. The
pre-P3/P4 global operation and financial schemas deliberately reject typed
HTTP-200 failed terminalization and receipt-less success settlement; non-200
2xx and 3xx also lack an approved final shape. Tests must keep those rows
non-terminal until DO migration 3 and the versioned financial terminal contract
land. Enabling any v3 writer before that point is a release blocker.

## Rollout Gates

The following independent gates remain `false` in default, staging, and
production until their named evidence is approved:

- `CONTAINER_PROVIDER_RESPONSE_V3_PARSE_ENABLED`
- `CONTAINER_PROVIDER_RESPONSE_RAW_WRITE_ENABLED`
- `CONTAINER_PROVIDER_RESPONSE_CLIENT_WRITE_ENABLED`
- `CONTAINER_PROVIDER_RESPONSE_TERMINAL_ENABLED`

Promotion is reader-first and blue/green until N/N-1 compatibility is proven.
Rollback disables dispatch and all four gates first, preserves readers and all
evidence, drains or quarantines in-flight v3 operations, and never rewrites a
terminal decision or resends an ambiguous provider attempt.

## Required Verification

- shared Rust/TypeScript canonical envelope corpus and exact byte/digest replay;
- duplicate, unknown, missing, reordered, invalid UTF-8/base64, overflow, and
  contradictory-field rejection;
- exact 200, typed 200, 201, 202, 204, 206, 3xx, 4xx, 5xx, malformed, scalar,
  array, empty, invalid UTF-8, and oversized provider responses;
- create/replay/conflict tests for both R2 namespaces and D1 identity ledgers;
- crash injection before and after every R2, D1, DO, terminal, and delivery
  boundary with zero provider resend;
- DO eviction/restart and mixed-version blue/green tests;
- runtime rejected-outcome tests, including typed 200 and provider 202; and
- remote schema/readback, lifecycle, load/cost/SLO, alert, rollback, and signed
  approval evidence before customer traffic.

## Local Implementation Status

The P3 code path is implemented locally as of 2026-07-18: Rust envelope writer,
TypeScript strict reader, phased D1/R2 artifact store, pre-dispatch recovery,
DO-local migration 3 attachment, and runtime interpreted rejection. Exact
success, typed HTTP-200 error, provider 202 and other HTTP errors, and invalid
body are covered without sharing financial authority.

All four rollout gates remain exact `false` in default, staging, and production
configuration. The terminal gate is additionally rejected before provider I/O
because P4 financial terminal ownership is not implemented. No remote schema,
object, deployment, provider, financial, secret, or traffic state was changed;
this remains a local candidate and production remains **NO-GO**.

The reader preallocates only an exact validated `content-length`, does not keep
a second canonical byte copy, and drops raw/client base64 text after decoding.
The narrower rollout bounds preserve headroom under Cloudflare's shared
[128 MB per-isolate memory limit](https://developers.cloudflare.com/workers/platform/limits/).
Raising them requires a streaming/direct-to-R2 design plus concurrent-isolate
load evidence; changing a flag is not an accepted promotion path.
