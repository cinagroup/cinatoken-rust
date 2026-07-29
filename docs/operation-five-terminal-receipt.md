# Operation-5 Terminal Receipt

## Status

The local Authority operation-5 terminal boundary is implemented and
default-off. Go/VPS remains authoritative. No remote Cloudflare state,
credential, deployment, migration, DNS, or traffic was accessed or changed.
Production remains **NO-GO**.

## Purpose

`gateway_status_stable` is durable deployment evidence, but it is not an
execution-ledger transition. The terminalizer closes that gap with one
Authority D1 statement:

```text
latest gateway_status_stable chain head
  -> operation-five terminal sidecar
  -> generic execution receipt sequence 5
  -> execution claim ledger_version 5
  -> last_completed_ordinal 5
  -> next operation ordinal 6
```

Migration `0007_operation_five_terminal_receipts.sql` owns the transition.
Its `AFTER INSERT` trigger projects the generic receipt, and the retained
migration-0002 receipt trigger advances the claim in the same SQLite
transaction. A projection failure rolls back both rows and leaves the claim
at ordinal 4.

## Route And Gate

```text
POST /internal/v1/shard-placement/execution-claims/{authorization_id_sha256}/complete-enable-dispatch
```

The route:

- uses the isolated Authority `receipt` HMAC role;
- accepts strict canonical JSON only;
- performs no Gateway, Controller, Cloudflare, or Application call;
- reads only immutable Authority D1 evidence;
- is controlled by
  `SHARD_PLACEMENT_AUTHORITY_OPERATION_FIVE_TERMINAL_WRITE_ENABLED`; and
- is `false` in tracked local and staging configuration.

The command binds the authorization, claim, owner, attempt, selected stable
Gateway event, and terminal command request identity. Exact replay requires
the same HMAC credential, HMAC request identity, and canonical command digest.

## Stable Deployment-State Digest

The Gateway public `observationDigestSha256` now hashes deployment state, not
the status request event. It includes:

- frozen command and target identities;
- status classification;
- deployments and version HTTP status;
- deployment-set SHA-256; and
- target-version response SHA-256.

It excludes status credential/request IDs, Cloudflare response request IDs,
timestamps, and other per-read identities. Two different status requests can
therefore produce the same state digest when the observed deployment state is
unchanged.

`targetStable=true` requires two target observations with:

- different status request IDs;
- the same deployment-state digest;
- identical deployment set and target-version evidence; and
- at least the configured 5-to-120-second separation.

The Controller enabled version ID and `target_version_sha256` are deliberately
different evidence. The former is the expected version identifier. The
latter is the SHA-256 of the bounded Cloudflare version response body. They
are persisted separately and are never compared as equal.

## Atomic Invariants

The terminal INSERT fails closed unless all of these are still true at D1
commit:

- the claim is `running`, generation 1, ordinal 5 in-flight, not
  readback-only, not taken over, not renewed, and not revoked;
- lease, permit, normal, and recovery deadlines are live;
- operation-5 start is sequence 4 and remains the execution ledger head;
- attempt, send-started event, admission, operation start, Controller command,
  idempotency key, database identities, and ledger identities all match;
- the selected `gateway_status_stable` event is the latest Gateway and mirrored
  send-event chain head;
- the stable event and its direct predecessor are target observations with the
  same state, deployment set, target response evidence, and Gateway version;
- no Gateway Worker version drift exists anywhere in the attempt chain;
- the current Authority Worker version equals the persisted dispatch Authority
  version;
- operation 6 exists as shard-0 readiness probe; and
- terminal manifest digest, generic receipt digest, before-ledger head, and
  after-ledger head are distinct and consistently bound.

After closure, a dedicated trigger rejects another Gateway event for the
attempt. Update and delete of the terminal sidecar are forbidden.

## Receipt Semantics

The terminal sidecar stores the actual terminal writer credential and request
identity. The projected generic execution receipt retains the operation-5
start actor identity, as required by migration 0002.

The generic receipt fields are:

- sequence `5`;
- event `operation_terminal`;
- operation ordinal `5`;
- outcome `exact_success`;
- predecessor equal to the operation-5 start receipt;
- evidence equal to the operation-5 admission confirmation digest;
- response equal to the canonical terminal evidence manifest digest; and
- Cloudflare request evidence equal to the stable status response request
  digest.

The terminal evidence manifest excludes the generic receipt digest and
after-ledger head to avoid a circular hash. The sidecar stores those values
separately and requires the after-ledger head to equal the generic receipt
digest.

## Replay And Failure Handling

| Failure | Result |
|---|---|
| Before terminal INSERT | No terminal row or sequence-5 receipt |
| INSERT or any source guard fails | Entire statement rolls back |
| Generic receipt projection fails | Sidecar rolls back |
| Commit response is lost after success | Exact sidecar readback returns replay |
| Same command and identities replay | Zero INSERT, zero Gateway call |
| Stable Gateway status response is lost | Same status request replays the original stable result |
| Different stable event or writer identity replay | `409` conflict |
| Stable event is no longer chain head | `409` conflict |
| Authority or Gateway version drift | `409` conflict |
| Revocation, takeover, expiry, or readback-only | Healthy terminal forbidden |

Takeover/readback-only, disable-required, drift, baseline, and ambiguous
outcomes must continue through the operation-14 disable/recovery design. They
must not be reclassified as a healthy operation-5 success.

## Verification

Local tests cover:

- real Gateway state-digest equality across different status requests;
- stable Gateway status replay preserving the original predecessor and result;
- stable rejection when classification, HTTP status, deployment set, or
  target-version evidence changes;
- fresh terminal success and exact replay without another source read or
  write;
- stable-event non-head rejection;
- Authority and Gateway version drift;
- revocation, expiry, takeover, disable-required, and readback-only;
- terminal immutability and post-terminal Gateway-chain sealing;
- generic receipt projection rollback; and
- migration installation in Workerd under D1 expression-depth limits.

## Remaining Production Blockers

The next local execution-ledger step is operation 6 readiness probing, followed
by operations 7-13 and the independent operation-14 disable/recovery path.
Remote D1 schema and normalized-trigger readback, private Service Binding
proof, least-privilege token evidence, HMAC rotation, rollout and
commit-response-loss fault campaigns, real mutation-count evidence, reverse
sync, drain, traffic and DNS cutover, and security/SRE approvals remain open.
