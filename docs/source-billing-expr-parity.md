# Source Billing Expression Parity (G4)

Date: 2026-06-25

Status: canonical, source-derived contract for the Go `billingexpr` engine and a
fixture-gap map against the Rust implementation. This is a G4 (billing parity)
deliverable consumed by `docs/billing-parity-runbook.md`. Billing is the highest-
risk cutover dimension; the Rust engine must match this contract bit-for-bit
before Rust owns any paid settlement.

Per the standing rule, this file was produced after reading
`C:\cinagroup\cinatoken\pkg\billingexpr\expr.md`.

## Source Of Truth

- Spec: `pkg/billingexpr/expr.md`.
- Engine: `pkg/billingexpr/{compile.go, run.go, settle.go, round.go, types.go}`.
- Golden corpus: `pkg/billingexpr/billingexpr_test.go` (56 tests).
- Token normalization caller: `service/tiered_settle.go` (`BuildTieredTokenParams`).

## Engine Contract (must match exactly)

### Variable environment (exact set)

`p`, `c`, `len`, `cr`, `cc`, `cc1h`, `img`, `img_o`, `ai`, `ao` — all `float64`,
default `0`. No others exist. (`run.go` `env` and `compile.go`
`compileEnvPrototypeV1` are the authority; `expr.md`'s table omits `img_o` from
the input list, but the code defines it — include it.)

### Functions (exact signatures)

| Fn | Signature | Semantics the Rust engine must replicate |
| --- | --- | --- |
| `tier` | `(name string, value float64) float64` | Records `MatchedTier=name`, `Cost=value`, returns `value`. Tier name is a string literal, not an identifier. |
| `param` | `(path string) any` | `gjson.GetBytes(body, path)`; empty path/body or missing -> `nil`; else `gjson .Value()` typing (number->float64, string, bool, array, object). Must match gjson path syntax incl. `#` array-count modifier. |
| `header` | `(key string) string` | Lookup in headers normalized to lowercase+trimmed keys, trimmed values, empties dropped. Case-insensitive. |
| `has` | `(source any, substr string) bool` | `strings.Contains(fmt.Sprint(source), substr)`; `nil` source or empty substr -> `false`. Stringify numbers the Go `fmt.Sprint` way. |
| `hour/minute/weekday/month/day` | `(tz string) int` | `time.LoadLocation(tz)`; empty or invalid tz -> `time.Now().UTC()`. weekday 0=Sunday. Wall-clock = non-deterministic. |
| `max/min/abs/ceil/floor` | math | Go `math.*` semantics. |

### Rounding

`QuotaRound(f) = int(math.Round(f))` — **round half away from zero**. Rust must
use round-half-away-from-zero (Rust `f64::round()` matches; do **not** use
banker's/round-half-to-even). Every path (pre-consume, settlement, log) uses this.

### Quota conversion (v1)

```
quotaBeforeGroup = exprOutput / 1_000_000 * QuotaPerUnit       (float, not rounded)
quotaAfterGroup  = QuotaRound(quotaBeforeGroup * groupRatio)    (rounded once, here)
```

Rounding happens **only** at the group-applied step. Do not round
`quotaBeforeGroup` intermediately. Coefficients are real $/1M-token prices (no
`/2` ratio convention).

### Version dispatch

`v1:` prefix -> version 1 and body after prefix; no prefix -> version 1. Version
selects compile env, normalization, and conversion formula. Result must be
`float64` (`expr.AsFloat64()`); a non-float result is an error.

### Token normalization (AST-driven auto-exclusion)

`extractUsedVars` walks the compiled AST for `IdentifierNode`s. In
`BuildTieredTokenParams`, for GPT/OpenAI-format usage (`prompt_tokens` includes
everything), a sub-category (`cr`,`cc`,`cc1h`,`img`,`ai` for `p`; `img_o`,`ao`
for `c`) is subtracted from `p`/`c` **only if the expression references that
variable**. For Claude-format usage (`input_tokens` is text-only), no
subtraction. `len` is **never** reduced: non-Claude `len = prompt_tokens`;
Claude `len = input_tokens + cache_read + cache_creation`.

### Cross-tier flag

`CrossedTier = (settlement MatchedTier != snapshot.EstimatedTier)`. The frozen
`BillingSnapshot` (expr string + hash + group ratio + estimates + estimated tier
+ QuotaPerUnit + version) is the settlement input.

### Request rules (`|||`)

Everything after `|||` is a separate request-rule multiplier expression, parsed
and applied separately from the base billing expression. Rule bodies must never
be written to logs (only `billing_mode`, base `expr_b64`, `matched_tier`).

## Parity-Critical Findings (easy to get wrong)

1. **gjson `param()` typing and `#` count.** `param("messages.#")` returns array
   length; numbers come back as `float64`. The Rust JSON-path implementation must
   match gjson, not a generic JSONPath — array-count and value typing differ
   across libraries. (`TestParamProbeArrayLength`, `TestParamProbeNestedBool`.)
2. **`has()` stringifies its source with Go `fmt.Sprint`.** `has(param("n"), "5")`
   where `n` is numeric depends on Go's float formatting. Match it.
3. **Rounding is half-away-from-zero and applied once.** Banker's rounding or
   double-rounding produces ±1 quota drift. (`TestQuotaRound`,
   `TestComputeTieredQuota_RoundingEdge[Down]`.)
4. **`len` must not be reduced by sub-category exclusion**, and Claude `len` adds
   cache back. Using `p` for tier conditions under heavy cache mis-tiers.
5. **Time helpers are non-deterministic** (wall clock, IANA tz, UTC fallback on
   empty/invalid). Fixtures must inject a clock or assert compile-only; do not
   golden-compare live values. (`TestTimeFunctions_*`.)
6. **Non-float result is an error**, not a coerced 0. A bare boolean expression
   must fail compile/run, matching Go.
7. **Tier names are literals, not identifiers** — they must not be picked up by
   used-variable extraction (which would corrupt sub-category exclusion).

## Golden Corpus → Fixture Family → Rust Status

56 Go tests grouped. Rust status uses the documented Rust coverage (multi-
condition expressions, cache split pricing, `len` tier conditions, ratio-
equivalent quota conversion, request probes, used-variable detection) as the
baseline; everything else is a gap.

| Group (Go tests) | Count | Fixture Family | Rust Status |
| --- | --- | --- | --- |
| `Claude_{Standard,LongContext,BoundaryExact}` | 3 | Tiered + len | Partial |
| `GLM_Tier{1,2,3}` | 3 | Tiered | Partial |
| `Len_{Standard,LongContext,BoundaryExact,BoundaryPlusOne,ZeroDefaults}` | 5 | len semantics | Partial |
| `Cache{Present_*,Absent_*},MixedCacheFields*,BackwardCompat` | 6 | Cache categories | Partial |
| `ComputeTieredQuota_{Basic,SameTier,WithCache,WithCacheCrossTier,BasicSettlement,WithGroupRatio,ZeroTokens,BoundaryTierCrossing}` | 8 | Settlement + group ratio + cross-tier | Partial |
| `ComputeTieredQuota_RoundingEdge[Down]`, `QuotaRound` | 3 | Rounding (half-away-from-zero) | **Done** (unified `quota_round`, 2026-06-26) |
| `RequestProbe*`, `HeaderProbeHelper`, `ParamProbe*`, `ProbeAffectsQuota` | 8 | Request probes / `|||` rules | Partial |
| `MathHelpers`, `CeilFloor` | 2 | Math helpers | **Missing** |
| `TimeFunctions_*` | 7 | Time helpers (tz, UTC fallback) | **Missing** |
| `Image*`, `Audio*`, `ImageAudio*` | 4 | Image/audio categories | **Missing/Partial** |
| `SimpleExpr_NoTier` | 1 | Flat / non-tiered pricing | **Missing** |
| `Fuzz_{NonNegativeResults,SettlementConsistency}` | 2 | Property/fuzz | **Missing** |
| `CompileError`, `CompileCache_SameResult`, `InvalidateCache`, `ExprHashString_Deterministic`, `ZeroTokens` | 5 | Compile/cache/hash/invalid | Partial |

## G4 Fixture-Gap Checklist (priority order)

Missing/verify first, since these block paid settlement:

1. **Rounding parity** — DONE 2026-06-26. The flat path now uses the single
   canonical `quota_round` (`int(math.Round)`, half-away-from-zero, saturating
   guards) shared with the tiered path; the divergent `+0.5`-truncation copy in
   `flat.rs` was removed. Go's "every billing path MUST use QuotaRound" rule is
   satisfied. Golden-fixture pinning (the `QuotaRound`/`RoundingEdge` Go test
   vectors) is covered by `lib.rs::quota_round_matches_go_half_away_from_zero`
   plus the flat-path integration assertion
   `flat_path_rounds_half_away_from_zero_like_go_quota_round`.
2. **Non-tiered (flat) billing** — DONE (2026-06-25..26). The flat path is
   implemented in `flat.rs::compute_flat_quota` and wired at `relay.rs`; the
   full ratio/price resolution + default-table base layer + sub-category
   arithmetic are in `pricing.rs` (see `docs/source-pricing-ratio-parity.md`).
   `quota=0/billing_pending` is cleared on settlement.
3. **Time helpers** — `hour/minute/weekday/month/day` with tz, UTC fallback, and
   the night-discount/weekday/month-day patterns; use an injectable clock.
4. **Image/audio variables** — `img`,`img_o`,`ai`,`ao` pricing plus no-double-
   subtraction; couple with request-time image-dimension/audio-duration estimate
   parity (open `TokenCountMeta` gap, fully specified in
   `docs/source-token-estimation-parity.md`).
5. **Math helpers** — `max/min/abs/ceil/floor` edge cases.
6. **Property/fuzz** — non-negative result and estimate-vs-settlement consistency
   over random token vectors (the execution plan's "property-based tests").
7. **gjson `param()` fidelity** — array `#` count, nested bool, missing->nil,
   numeric typing; pin the Rust JSON-path lib's behavior against gjson.
8. **Cross-tier settlement** — `WithCacheCrossTier`, `BoundaryTierCrossing`:
   estimate in one tier, settle in another; assert `CrossedTier` and final quota.
9. **Invalid/compile** — unknown var/function, bad arity, non-float result,
   inactive-branch validation, deterministic hash.

Every fixture uses the `billing-parity-runbook.md` fixture record format and runs
identical inputs through Go and Rust, comparing cost, quota, matched tier, and
refund/additional delta.

## Wire-In

- `docs/billing-parity-runbook.md` Golden Fixture Matrix consumes this gap list;
  this file adds the source-grounded engine contract and the test-by-test map.
- `docs/production-readiness-matrices.md` Billing matrix and the G4 gate row
  reference this file.
- No Rust billing-expression change may merge without adding the corresponding
  Go↔Rust golden fixture named here.
