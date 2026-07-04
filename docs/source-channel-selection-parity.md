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

Implementation status (verified 2026-07-04): `crates/worker/src/d1_repositories.rs::
select_channels_from_abilities` selects via **deterministic SQL ordering**
(`ORDER BY a.priority DESC, a.weight DESC, c.priority DESC, c.id ASC LIMIT 50`).
`select_relay_channels` returns the ordered candidate pool;
`cinatoken_core::channel_select::select_weighted` (priority-tier-by-`retry` +
Go's two smoothing modes) is **wired** into the relay retry loop
(`crates/worker/src/relay.rs`): each attempt builds `Candidate` from the
row's `priority`/`weight`, picks via `select_weighted(meta, attempt_index, rng)`
with a Worker CSPRNG-backed unbiased `[0,total)` RNG (`getrandom` with u64
rejection sampling), and removes the pick from the pool. `RelayChannel` carries
`priority`/`weight` (`crates/storage`).

Benign divergence from Go (documented): the Rust pool **shrinks** each attempt
(`pool.remove(pick)`), so a channel is never retried; Go re-selects from the full
set each retry and *can* repeat the same channel. Rust's behavior spreads retries
better within a tier.

Auto cross-group retry — **state machine ported 2026-06-27** as the pure
`cinatoken_core::channel_select::auto_group_retry_step` (faithful port of
`CacheGetRandomSatisfiedChannel`'s group/priority walk: start group uses
`priorityRetry = retry`, later groups restart at 0 so a group exhausts its
priorities before the next is tried; `crossGroupRetry && priorityRetry >=
RetryTimes` arms a group advance for the next retry via the `ResetRetryNextTry`
semantics; returns the per-attempt `(group_index, priority_retry)` plus the
`(next_group_index, next_retry, reset_retry_next_try)` to persist). 6 unit tests
incl. a full two-group loop trace. The group-config layer is ported too
(2026-06-27): `cinatoken_core::groups::{user_usable_groups, user_auto_groups}`
faithfully port `service.GetUserUsableGroups` (base usable map + per-group
`+:`/`-:`/plain special overrides + ensure the user's own group) and
`service.GetUserAutoGroup` (auto-groups list ∩ usable, in configured order); 9
unit tests. The settings/resolution layer is wired too (2026-06-27):
`d1_repositories::resolve_user_auto_groups` reads the `AutoGroups`,
`UserUsableGroups`, and `group_ratio_setting.group_special_usable_group` options
and feeds them through `core::groups::user_auto_groups` (pure parse/resolve, 3
tests). **Relay-loop integration WIRED 2026-06-27** (`relay.rs`): selection is
now planned up front by `plan_relay_attempts`, which produces the ordered
`(group, channel)` attempts — the single-group branch reproduces the prior
inline `select_weighted` + pool-shrink behavior exactly (so non-auto traffic is
unchanged), and the `is_auto` branch (triggered by `token_group == "auto"`)
resolves the user's groups via `resolve_user_auto_groups`, fetches candidates
**per group**, and drives `auto_group_retry_step`. Billing now resolves the
group ratio from the **selected** group: the preflight uses the first planned
attempt's group, and settlement uses the actual serving channel's group (passed
into `complete_relay_response`/`complete_streaming_relay_response`). 4 planner
unit tests; non-auto suite unchanged (129 worker tests).

Documented divergences / caveats (need **staging verification** — D1 reads + e2e
cannot be tested locally):
- `cross_group_retry` is not yet a ported per-token setting; auto tokens default
  it to `true` (priority exhaustion advances to the next group). Port the token
  field to honor per-token config.
- The tiered-billing **frozen snapshot** uses the *first* planned attempt's
  group ratio; if a cross-group retry lands on a different group, the tiered
  charge still uses the first group's ratio (flat settlement uses the serving
  group correctly). Fully faithful tiered+auto needs per-attempt reserve (Go
  reserves per retry), a larger billing-flow change.
- "auto groups is not enabled" (503) is returned when the *user-filtered* auto
  list is empty; Go returns that only for the *globally* empty case and otherwise
  falls through to a no-channel error. Same outcome (request fails), different
  wording/status.
- Settings are read straight from D1 options with no in-memory default seeding;
  Go seeds defaults (`{default,vip}` usable, `[default]` auto) then overlays DB.
  The D1 options must be seeded (migration) or auto resolution can differ from Go
  on an unseeded deployment.

Adversarial verification (2026-06-27) confirmed non-auto behavior is byte-for-byte
preserved and caught two bugs that were fixed before this note: the non-stream
settlement passed the `"auto"` token group instead of the serving group (flat
mis-bill); and the auto planner used a single global attempt cap instead of Go's
per-group retry budget (cross-group failover never advanced when the first group
had channels). Both have regression tests.

Affinity (1.3) — minimal version is now code-complete (off by default; see the
G3 checklist item 4 below), pending staging runtime verification + deploy.

The selection-specific parity gaps to close before relay canary:

1. **Weighted-random + smoothing parity** — port `GetRandomSatisfiedChannel` with
   a seeded RNG and add a distribution test (e.g. chi-square over N draws) vs the
   Go algorithm for: single priority, multi-priority, all-zero weights, avg<10
   weights, single candidate.
2. **Retry->priority mapping** — fixture that retry 0..k walks priorities highest
   to lowest with clamping.
3. **Auto cross-group retry** — DONE 2026-06-27: pure state machine
   (`core::channel_select::auto_group_retry_step`) + config layer
   (`core::groups`, `d1_repositories::resolve_user_auto_groups`) + relay-loop
   wiring (`relay.rs::plan_relay_attempts`, billing on the selected group). See
   the status note above for the two staging-verification caveats (per-token
   `cross_group_retry`; tiered+auto frozen-snapshot ratio).
4. **Affinity layer** — **minimal version DONE 2026-06-27** (code-complete,
   off-by-default). A `ChannelAffinity` Durable Object (`crates/worker/src/affinity.rs`,
   per §21.2) holds one sticky preferred channel per `(user, model, group)` with
   a fixed TTL; the relay loop reorders the preferred channel to the front of the
   attempt plan (`move_preferred_to_front`, before `billing_group`) and records
   it on a `< 400` upstream response. Gated on `RELAY_CHANNEL_AFFINITY_ENABLED`
   (a no-op when off — verified no regression) and **fails open** on any
   binding/DO error. wrangler.toml declares the binding + `new_sqlite_classes`
   migration in all three env scopes. Adversarially verified (DO API, fail-open,
   wiring, config — 0 findings); pure logic unit-tested. **Remaining vs Go**
   (documented simplifications): no L1 in-memory cache (one DO round-trip/request
   when enabled), single fixed TTL, the `(user, model, group)` key instead of
   Go's configurable rule sources/regex/override-templates/stats, and
   `ShouldKeepChannelAffinityOnChannelDisabled` not modeled. **Runtime
   verification is staging-gated** (DOs need `wrangler dev`/staging) and the new
   DO requires a `wrangler deploy` migration.
5. **Pre-selection gates** — token model-limit: DONE 2026-06-26. The pure
   `model_allowed_for_token` helper (in `relay.rs`) mirrors Go
   `middleware/distributor.go:60-76`: limits disabled → allow; otherwise
   normalize the request model via `format_matching_model_name` and require it
   in the limits CSV; an enabled-but-empty limit list denies everything (Go's
   empty-map → 403, reproduced because `csv_contains("") == false`). 7 unit
   tests cover disabled/exact/wildcard(gizmo+thinking)/deny/empty-deny-all/
   case-insensitive. Still pending: the specific-channel pin gate.
6. **Model normalization** — DONE 2026-06-26 for the ability lookup:
   `select_relay_channels` now mirrors Go's exact-then-normalized fallback
   (`GetRandomSatisfiedChannel`, `model/channel_cache.go:107-113`): query
   abilities with the raw requested model; if empty and
   `format_matching_model_name(model) != model`, re-query with the normalized
   name (via the pure `normalized_fallback_model` helper). This routes
   thinking-budget/gizmo models (`gemini-2.5-flash-thinking-8192` →
   `gemini-2.5-flash-thinking-*`) to their wildcard-keyed ability. The common
   exact-match path stays one D1 round-trip. Still pending: normalization in the
   token model-limit gate and the last-resort channel-CSV scan.

## Wire-In

- `docs/source-retry-autoban-parity.md` for how `retry` advances on failure and
  how a failed channel is auto-banned (and must be evicted from this cache).
- `docs/route-provider-parity-runbook.md` Provider Adapter Contract "Channel
  selection" row consumes this spec.
- `docs/production-readiness-matrices.md` G3 row and the channel-admin/ability
  rows reference this file.
- The affinity store decision is owned by the cache/rate-limit plan in
  `docs/production-migration-execution-plan.md` (Durable Objects per §21.2).
