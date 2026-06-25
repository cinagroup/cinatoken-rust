# Source Channel Selection Parity (G3 Core)

Date: 2026-06-25

Status: canonical, source-derived specification of the Go channel-selection and
routing "brain" — the logic that turns (token, group, model) into a concrete
(channel, key, upstream model). This is the heart of G3 relay parity. The Rust
channel selector must reproduce this behavior or document every intentional
difference, because selection determines which upstream every request hits and
how retries fan out.

## Source Of Truth

- `middleware/distributor.go` — `Distribute()` orchestration.
- `service/channel_select.go` — `CacheGetRandomSatisfiedChannel` (auto cross-group
  retry).
- `model/channel_cache.go` — `GetRandomSatisfiedChannel` (priority + weighted
  random + smoothing).
- `model/channel_satisfy.go` — `IsChannelEnabledForGroupModel`.
- `model/channel.go` — `GetPriority()`/`GetWeight()` nil defaults.

## Selection Pipeline (`Distribute()`, ordered)

1. **Specific-channel pin.** If the token pins a channel
   (`ContextKeyTokenSpecificChannelId`), load it by id, require
   `Status == enabled`, and **bypass all selection**. Disabled -> 403.
2. **Token model-limit.** If the token has model limits enabled, the requested
   model (normalized via `FormatMatchingModelName`) must be in the allow-map,
   else 403. Empty limit map = no models allowed.
3. **Group resolution.** `usingGroup` from context; for `/pg/chat/completions`
   the playground body may override the group, but only to a group the user may
   use (`GroupInUserUsableGroups`).
4. **Affinity preference.** `GetPreferredChannelByAffinity(user/token, model,
   group)`: if a preferred channel exists, is enabled, and is enabled for the
   (group, model) pair, use it directly (for `auto`, iterate the user's auto
   groups to find one where it is enabled). Mark affinity used. If not usable and
   `ShouldKeepChannelAffinityOnChannelDisabled` is false, clear the affinity
   cache.
5. **Weighted random selection.** If no affinity channel,
   `CacheGetRandomSatisfiedChannel` (below) selects by group/model/priority/weight.
6. **Setup + record.** `SetupContextForSelectedChannel`, run the relay, then on
   success (`status < 400`) `RecordChannelAffinity(channel.Id)`.

## Core Algorithm: `GetRandomSatisfiedChannel(group, model, retry)`

Exact behavior the Rust selector must match:

1. Candidate list = `group2model2channels[group][model]`; if empty, retry with
   `FormatMatchingModelName(model)` (handles `gpts` and `thinking-*` matching).
   Empty -> no channel.
2. If exactly one candidate, return it.
3. Collect the **unique priorities** of candidates and sort **descending**.
4. **Priority by retry index**: `if retry >= len(uniquePriorities): retry =
   len-1`; `targetPriority = sortedUniquePriorities[retry]`. So retry 0 = highest
   priority, retry 1 = next-lower, clamped at the lowest. Priority is
   `GetPriority()` (nil pointer -> 0).
5. Among candidates whose priority == targetPriority, **weighted random with
   smoothing**:

```text
sumWeight = sum(GetWeight(ch) for ch in target)         # GetWeight nil -> 0
smoothingFactor = 1
smoothingAdjustment = 0
if sumWeight == 0:                                       # all weights zero
    sumWeight = len(target) * 100
    smoothingAdjustment = 100                            # uniform pick
elif sumWeight / len(target) < 10:                       # integer division
    smoothingFactor = 100
totalWeight = sumWeight * smoothingFactor
r = rand_int_in_[0, totalWeight)                         # rand.Intn
for ch in target:                                        # candidate order preserved
    r -= GetWeight(ch) * smoothingFactor + smoothingAdjustment
    if r < 0: return ch
```

The integer division in `sumWeight/len(target) < 10`, the two distinct smoothing
modes, and the candidate iteration order all affect the probability
distribution. Rust must reproduce them exactly (or document a deliberate change
and re-baseline expected distributions).

## Auto Cross-Group Retry State Machine

For `tokenGroup == "auto"` (`CacheGetRandomSatisfiedChannel`):

- The user's auto groups come from `GetUserAutoGroup(userGroup)`.
- Each group **exhausts all its priorities before moving to the next group**.
- `ContextKeyAutoGroupIndex` tracks the current group; `priorityRetry` is the
  in-group priority index; on moving to a new group `priorityRetry` resets to 0.
- With `crossGroupRetry` and `priorityRetry >= RetryTimes`, the current request
  still uses the current group but the next retry advances the group
  (`ResetRetryNextTry`).
- Non-auto groups call `GetRandomSatisfiedChannel(group, model, retry)` directly.

The outer relay retry loop drives `retry`; selection maps `retry` to a priority
tier (single group) or to a (group, priority) pair (auto). The Rust retry loop
must preserve this mapping so retries walk priorities then groups in the same
order.

## Parity-Critical Findings

1. **Smoothing math is exact, not approximate.** The `<10` integer-average
   branch and the all-zero uniform branch change selection probabilities. A
   naive `weight`-proportional pick will diverge from Go for low/zero weights.
2. **`retry` is a priority index, not a channel index.** Retry N selects the
   Nth-highest distinct priority (clamped), then weighted-random within it.
3. **Model normalization is applied in three places** (ability lookup, token
   model-limit, candidate fallback) via `FormatMatchingModelName`. Rust must use
   one shared normalizer with identical `gpts`/`thinking-*` rules.
4. **nil priority/weight default to 0** (`GetPriority`/`GetWeight`). The D1
   schema stores these `NOT NULL DEFAULT 0`, so import maps NULL->0 (consistent),
   but the Rust selector must still treat missing as 0.
5. **Affinity is stateful hot-path read/write.** Preferred-channel lookup,
   `MarkChannelAffinityUsed`, and `RecordChannelAffinity` run per request. Per
   migration-plan §21.2 this state should live in a Durable Object (or KV), not
   Upstash; affinity must fail open (fall back to random selection) when its
   store is unavailable.
6. **Specific-channel pin and token model-limit are pre-selection gates** with
   their own error codes (403). Rust must enforce them before any
   group/affinity/weight logic, matching status codes.
7. **Affinity is recorded only on success** (`status < 400`) and bypassed when a
   channel is disabled. Recording on failures would pin users to bad channels.

## Rust Status And G3 Checklist

Implementation status (verified 2026-06-25): `crates/worker/src/d1_repositories.rs::
select_channels_from_abilities` selects via **deterministic SQL ordering**
(`ORDER BY a.priority DESC, a.weight DESC, c.priority DESC, c.id ASC LIMIT 50`).
This is **not** the Go weighted-random-with-smoothing algorithm — it is a stable
priority/weight ordering. The smoothing weighted-random math is now ported as a
pure, RNG-injected, unit-tested function
`cinatoken_core::channel_select::select_weighted` (priority-tier-by-`retry` +
Go's two smoothing modes), **pending wiring** into `select_relay_channels`
(fetch candidate priorities/weights, then call `select_weighted(.., retry, rng)`
instead of taking the first ORDER BY row). Affinity and auto cross-group retry
parity are still pending.

The selection-specific parity gaps to close before relay canary:

1. **Weighted-random + smoothing parity** — port `GetRandomSatisfiedChannel` with
   a seeded RNG and add a distribution test (e.g. chi-square over N draws) vs the
   Go algorithm for: single priority, multi-priority, all-zero weights, avg<10
   weights, single candidate.
2. **Retry->priority mapping** — fixture that retry 0..k walks priorities highest
   to lowest with clamping.
3. **Auto cross-group retry** — state-machine fixtures for "exhaust priorities
   then advance group", with and without `crossGroupRetry`.
4. **Affinity layer** — preferred-channel reuse, disabled-channel fallthrough,
   record-on-success-only, and store-outage fail-open; on Durable Objects per
   §21.2.
5. **Pre-selection gates** — specific-channel pin (enabled check, 403) and token
   model-limit (normalized match, empty-map deny) with matching status codes.
6. **Model normalization** — shared `FormatMatchingModelName`-equivalent used in
   ability lookup, model-limit, and candidate fallback.

## Wire-In

- `docs/source-retry-autoban-parity.md` for how `retry` advances on failure and
  how a failed channel is auto-banned (and must be evicted from this cache).
- `docs/route-provider-parity-runbook.md` Provider Adapter Contract "Channel
  selection" row consumes this spec.
- `docs/production-readiness-matrices.md` G3 row and the channel-admin/ability
  rows reference this file.
- The affinity store decision is owned by the cache/rate-limit plan in
  `docs/production-migration-execution-plan.md` (Durable Objects per §21.2).
