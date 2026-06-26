# Source Pricing And Ratio Resolution Parity (G4, non-tiered)

Date: 2026-06-25

Status: canonical, source-derived specification of the **non-tiered (legacy
ratio/price) billing path** — the default for most models, distinct from the
tiered expression engine in `docs/source-billing-expr-parity.md`. This is the
`quota=0 / billing_pending` gap flagged there: until Rust implements this path,
any ratio/price-billed model cannot settle. Highest-priority remaining billing
work.

## Source Of Truth

- `relay/helper/price.go` — `ModelPriceHelper` (per-token + per-call branch),
  `ModelPriceHelperPerCall`, `HandleGroupRatio`, `HasModelBillingConfig`.
- `setting/ratio_setting/{model_ratio,group_ratio,cache_ratio}.go` —
  `GetModelPrice`, `GetModelRatio`, `GetCompletionRatio`, `GetCacheRatio`,
  `GetCreateCacheRatio`, `GetImageRatio`, `GetAudioRatio`,
  `GetAudioCompletionRatio`, `GetGroupRatio`, `FormatMatchingModelName`.
- Settlement: `service/billing.go` (post-consume; symmetric to pre-consume here).

## Three-Way Billing Branch (per model)

`ModelPriceHelper` chooses one path after `FormatMatchingModelName(name)`:

1. **Per-call (fixed price)** — `GetModelPrice(name)` returns `usePrice=true`:
   `quota = modelPrice * QuotaPerUnit * groupRatio` (`* ImagePriceRatio` when set).
2. **Tiered expression** — `GetBillingMode(name) == tiered_expr`: delegate to
   `modelPriceHelperTiered` (see `docs/source-billing-expr-parity.md`).
3. **Per-token (ratio)** — otherwise: the classic ratio formula below.

## Per-Token Ratio Resolution

Ratios resolved from the options-backed maps (all via `FormatMatchingModelName`):

| Ratio | Getter | Meaning |
| --- | --- | --- |
| modelRatio | `GetModelRatio` | base $/token multiplier; **default 37.5** when unconfigured |
| completionRatio | `GetCompletionRatio` | completion-token multiplier over modelRatio |
| cacheRatio | `GetCacheRatio` | cache-read token multiplier |
| cacheCreationRatio | `GetCreateCacheRatio` | cache-write (5m); 1h = 5m * `claudeCacheCreation1hMultiplier` |
| imageRatio | `GetImageRatio` | image-token multiplier |
| audioRatio / audioCompletionRatio | `GetAudioRatio` / `GetAudioCompletionRatio` | audio in/out multipliers |
| groupRatio | `GetGroupRatio` (via `HandleGroupRatio`) | per-group multiplier |

Pre-consume estimate:

```
preConsumedTokens = max(promptTokens, PreConsumedQuota) + meta.MaxTokens
preConsumedQuota  = preConsumedTokens * (modelRatio * groupRatio)
```

Settlement (post-consume, symmetric) prices each token sub-category at its ratio
relative to `modelRatio`, then `* groupRatio`. Conceptually:

```
billable = promptText
         + completion        * completionRatio
         + cacheRead         * cacheRatio
         + cacheCreate5m     * cacheCreationRatio
         + cacheCreate1h     * cacheCreationRatio1h
         + image             * imageRatio
         + audioIn           * audioRatio
         + audioOut          * audioCompletionRatio
quota = round(billable * modelRatio * groupRatio)
```

(Confirm the exact sub-category arithmetic against `service/billing.go` when
porting; the variable set above is authoritative.)

## Resolution Edge Cases (match exactly)

1. **Unconfigured model ratio defaults to `37.5`**, but `GetModelRatio` returns
   `success = SelfUseModeEnabled`. So outside self-use mode an unconfigured model
   is treated as *not configured* and errors (`modelPriceNotConfiguredError`)
   **unless** the user's `AcceptUnsetRatioModel` is set. Rust must reproduce this
   tri-state (configured / default-37.5-in-self-use / error).
2. **Hardcoded completion ratios.** `GetCompletionRatio` consults a built-in
   per-model table (`getHardcodedCompletionModelRatio`) before/around the options
   map. Rust must port the hardcoded table, not only the options map.
3. **Compact-suffix wildcard.** Models ending in `CompactModelSuffix` fall back to
   a wildcard price/ratio key.
4. **Thinking-budget wildcard.** `handleThinkingBudgetModel` maps `*-thinking-*`
   names to a wildcard for unified pricing.
5. **`FormatMatchingModelName`** is the shared normalizer used here and in channel
   selection, token model-limit, and tiered billing — one implementation.
6. **Free model.** When `!EnableFreeModelPreConsume`, pre-consume is 0 and
   `freeModel=true` if `groupRatio==0`, or (`usePrice && modelPrice==0`), or
   (`!usePrice && modelRatio==0`).
7. **Per-call image multiplier.** In the per-call branch, `meta.ImagePriceRatio`
   multiplies `modelPrice` before quota.

## Parity-Critical Findings

1. **This is the default path.** Most models are ratio/price-billed, not tiered.
   Status correction (verified 2026-06-25): this path is **implemented and wired**
   — `crates/billing/src/flat.rs::compute_flat_quota` (porting Go
   `service/text_quota.go::calculateTextQuotaSummary`) is called from
   `crates/worker/src/relay.rs:3200`, and `billing_pending` is cleared on
   settlement. It is no longer a `quota=0` blocker; the remaining work is the
   documented simplifications below, not the core path.
2. **Ratio maps are options-backed and hot-read every request** (`modelRatioMap`,
   `modelPriceMap`, `completionRatioMap`, `cacheRatioMap`, `imageRatio`, audio,
   `groupRatio`). Cache them in CONFIG_KV / a Durable Object (§21.2) and
   **invalidate on option mutation** (admin cache-invalidation policy). Loaded
   via `UpdateModelRatioByJSONString`-style JSON from the `options` table — ties
   to the Option table migration (P0).
3. **`QuotaPerUnit`** is the quota<->USD constant; per-call uses
   `price * QuotaPerUnit * groupRatio`. Match its value and the rounding
   (`docs/source-billing-expr-parity.md` rounding rules apply).
4. **Sub-category ratios mirror the tiered variables** (`cr`/`cc`/`cc1h`/`img`/
   `ai`/`ao`) so usage parsing (`docs/source-usage-parsing-parity.md`) feeds both
   paths; reuse the same parsed `Usage`.
5. **Default-37.5 + self-use/AcceptUnsetRatio tri-state** is an easy divergence
   that changes whether unconfigured models bill or error.

## Rust Status And Checklist

Implementation status (verified 2026-06-25 against the working tree): the
per-call and per-token paths are **implemented and wired** in
`crates/billing/src/{flat,pricing}.rs` + `crates/worker/src/relay.rs`. Confirmed
gaps vs Go (the actual remaining work):

- **Hardcoded completion-ratio table** — `pricing.rs::completion_ratio` now
  applies Go's exact precedence (verified 2026-06-26): the model name is run
  through `format_matching_model_name`; a `/`-name returns ONLY on an options-
  map hit (a miss falls through to the table, faithful to Go), then
  `cinatoken_core::hardcoded_completion_ratio` is consulted and its
  `authoritative` value wins over the options map, a non-authoritative value
  is a soft default the map can override, and fully-unknown models fall back to
  `1.0`. The full Go table is the pure, tested
  `cinatoken_core::completion_ratio::hardcoded_completion_ratio` (gpt-4o*→4,
  claude-*→5, gpt-5*→8, o1/o3→4, gemini/command/ERNIE/llama branches).
  Faithful-port finding: Go's dedicated `gpt-3.5` block is **dead code** (the
  `gpt-` prefix block returns `(2.0, false)` first), so every `gpt-3.5*`
  resolves to `(2.0, false)` — the port preserves this; do not "fix" it without
  matching Go.
- **Default-table base layer + 37.5/self-use tri-state** — DONE 2026-06-26.
  Go's `InitRatioSettings` seeds the operator ratio/price/completion maps with
  hardcoded defaults as a base the operator `options` overrides per-entry.
  `pricing.rs::{model_ratio,model_price,completion_ratio}` now consult
  `cinatoken_core::default_ratios` (`defaultModelRatio` ~250 entries,
  `defaultModelPrice`, `defaultCompletionRatio`) as a fallback beneath the
  operator map; `with_self_use_mode(true)` reproduces Go's `37.5` unconfigured
  default (`SelfUseModeEnabled`); `worker/relay.rs::has_pricing` now counts a
  default-table model as priced so e.g. unconfigured `gpt-4o` bills at 1.25
  instead of being treated as free. Still pending: `AcceptUnsetRatioModel`
  per-user override + the `modelPriceNotConfigured` error outside self-use.
- No cache-creation 5m/1h split (single `cache_ratio`); no `ToolCallSurcharge`;
  no `OtherRatios` (image `n` multiplier). The cache/audio/image default tables
  (`defaultCacheRatio`, `defaultAudioRatio`, ...) are NOT yet ported —
  `cache_ratio` consults the operator map only.
- Image/audio tokens are **not** subtracted from the prompt base in flat mode
  (billed at prompt rate) — differs from the full sub-category formula above.

Remaining checklist:

1. Three-way branch (per-call / tiered / per-token) — done; verify the
   `GetModelPrice`-vs-billing-mode keying matches Go.
2. `FormatMatchingModelName` + the hardcoded completion-ratio table are wired
   (verified 2026-06-26) into `pricing.rs::completion_ratio` with Go's
   authoritative > options-map > soft-default precedence. The default-table
   base layer + 37.5/self-use tri-state are also wired (2026-06-26): the Go
   `defaultModelRatio`/`Price`/`CompletionRatio` tables are ported as
   `cinatoken_core::default_ratios` and consulted beneath the operator map,
   and `with_self_use_mode` reproduces the unconfigured-37.5 path. The
   compact-suffix (`-openai-compact`) wildcard fallback is wired (2026-06-26)
   into `model_ratio`/`model_price`, and `has_model_pricing` consults the same
   layers so the billability gate agrees. Still pending: the
   `AcceptUnsetRatioModel` per-user override + `modelPriceNotConfigured` error
   outside self-use, and the cache/audio/image default tables (those feed the
   sub-category settlement arithmetic, still simplified).
3. Load ratio/price/group maps from `options` into a cached, invalidated store
   (CONFIG_KV/DO); refresh on admin option mutation.
4. Implement the per-token settlement arithmetic with the full sub-category ratio
   set and the rounding rules; reuse parsed `Usage`.
5. Implement the free-model rule and `EnableFreeModelPreConsume`.
6. Add Go<->Rust golden fixtures: per-call, per-token, each sub-category ratio,
   unconfigured (self-use vs error), free model, group ratio 0/fractional/large.

## Wire-In

- `docs/source-billing-expr-parity.md` (tiered) and this file (non-tiered) are
  the two billing-resolution paths; both consume parsed `Usage`
  (`docs/source-usage-parsing-parity.md`).
- `docs/billing-parity-runbook.md` "Flat text pricing" / "Group ratio" fixture
  families and `docs/production-readiness-matrices.md` Billing matrix reference
  this file.
- Ratio-map caching/invalidation follows migration-plan §21.2 and the
  admin cache-invalidation policy.
