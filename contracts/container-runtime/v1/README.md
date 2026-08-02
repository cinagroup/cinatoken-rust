# Container runtime contract v1

This directory records the cross-language contract between the TypeScript
container controller and the Rust Linux container runtime.

The checked-in sources and gates are:

- `container-runtime.openapi.json`: implemented private HTTP/JSON v1 contract.
- `container_runtime.proto`: reserved protobuf message model; transport is off.
- `conformance/operation-envelope-cases.json`: shared TS/Rust acceptance vectors.
- `redocly.yaml` and the repository `buf.yaml`: lint and compatibility policy.
- `bun run check:container-runtime:contracts`: OpenAPI, Buf, structural parity,
  fixed field-number, and TypeScript conformance gate. Rust consumes the same
  vectors in `cinatoken-container-runtime` unit tests.

## Contract status

- `container-runtime.openapi.json` is canonical for the currently implemented
  HTTP and JSON v1 behavior.
- `container_runtime.proto` is the canonical message model for the target
  `application/x-protobuf` transport.
- Protobuf transport is **not implemented**. Neither side currently performs
  protobuf encoding, decoding, `Content-Type` handling, or `Accept`
  negotiation. The OpenAPI document exposes it only through explicit
  `target-not-implemented` vendor extensions.
- The implemented operation request uses `Content-Type: application/json` and
  `x-cinatoken-container-protocol: 1`. The Rust parser also accepts structured
  `application/*+json` media types, but the controller emits
  `application/json`, which is the canonical compatibility media type.
- The runtime has no application-level authentication. It relies on the
  controller-managed container loopback boundary, and the protocol-version
  header is not an authentication credential. The runtime must not be exposed
  as a public origin.

## Audited sources

The v1 definitions were reconciled against:

- `services/container-controller/src/protocol.ts`
- `crates/container-runtime/src/lib.rs`

The shared request surface uses the stricter boundary where the two validators
differ:

| Area | TypeScript controller | Rust runtime | v1 contract |
| --- | --- | --- | --- |
| Object keys | exact keys | unknown fields denied | exact keys; no explicit null optionals |
| Identifier alphabet | `[A-Za-z0-9._:-]` | also accepts `/` and `@` | controller alphabet |
| Request `content_type` | at most 128 bytes | at most 255 bytes | at most 128 bytes |
| R2 request key | 8 to 512 bytes | 1 to 1024 bytes | 8 to 512 bytes |
| R2 object version | at most 128 bytes | at most 256 bytes | at most 128 bytes |
| Integer range | JavaScript safe integer | native unsigned integers | JavaScript safe integer |
| Shard name | canonical four-digit suffix | canonical four-digit suffix | canonical four-digit suffix |

The runtime additionally enforces relationships that JSON Schema cannot fully
express:

- `execution_deadline_at` is in the future, no more than 300 seconds from
  admission, and no later than `owner_lease_expires_at`.
- `shard_index` is less than `shard_count`, and the instance-name suffix equals
  the shard index.
- R2 references are both present; inline references are both absent.
- Operation response fields follow the status-specific presence matrix in the
  OpenAPI `oneOf` schemas and proto comments.
- For provider `http_error`, `client_status` equals `provider_status` and the
  latter is not 200.
- A client artifact key binds the operation ID, owner generation, and artifact
  digest.

## Evolution rules

1. Treat v1 field names, JSON presence rules, proto field numbers, status
   meanings, and validation bounds as frozen.
2. Because both current JSON readers reject unknown fields, adding a JSON field
   is not safely backward compatible. Introduce a negotiated protocol version
   and a new version directory for wire changes.
3. Never reuse a proto field number. Reserve removed numbers and names in the
   successor schema.
4. Keep TypeScript numbers within `Number.MAX_SAFE_INTEGER`, even when the proto
   field uses `uint64`.
5. Do not advertise `application/x-protobuf` in standard OpenAPI request or
   response content until both implementations pass shared conformance vectors,
   content negotiation tests, and mixed-version rollback tests.
6. A transport change must preserve authorization, body-size, deadline, shard,
   response-presence, and error semantics; binary encoding is not a new logical
   protocol version by itself.
7. Run Buf breaking checks against the last released v1 schema before changing
   a published field or enum. The initial v1 publication has no earlier Buf
   baseline; later changes do not receive that exception.
