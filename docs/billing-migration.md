# Billing Migration

## Current Rust State

`crates/billing` now contains the first pure Rust billing primitives:

- `DEFAULT_QUOTA_PER_UNIT = 500_000.0`, matching the Go setting default.
- `quota_round()`, matching Go `math.Round` half-away-from-zero behavior.
- `parse_expr_version()` with `v1:` support and v1 as the default version.
- `detect_billing_expr_variables()` for the billing variables that drive
  token normalization.
- `build_tiered_token_params()` for GPT/OpenAI versus Claude token
  normalization:
  - GPT/OpenAI semantics subtract cache/image/audio sub-categories from `p`
    and `c` only when the expression references the matching variable.
  - Claude semantics keep `p` text-only and compute `len` as text plus cache
    read and cache creation tokens.
  - `len` remains the raw/full input context length for tier conditions.
- `expression_cost_to_quota()`, using the original formula:

```text
quota = expression_cost / 1_000_000 * QuotaPerUnit * groupRatio
```

- `flat_text_quota()` for prompt/completion price calculations.
- `settle()` for pre-consume versus actual-use delta reporting.
- `run_billing_expr()` and `run_billing_expr_with_request()` for the first Rust
  expression execution foundation:
  - arithmetic, comparisons, logical operators, ternary conditionals, and
    parentheses;
  - billing variables `p`, `c`, `len`, `cr`, `cc`, `cc1h`, `img`, `img_o`,
    `ai`, and `ao`;
  - `tier()` trace capture, `max`, `min`, `abs`, `ceil`, and `floor`;
  - request-aware `param()`, `header()`, and `has()`;
  - UTC-first time helpers with common Asia time zone offsets.
- `RequestInput`, `TraceResult`, and `ExprRun` for passing request probes and
  carrying matched-tier metadata.
- `BillingSnapshot` for freezing estimated inputs before settlement.
- `TieredBillingSnapshot`, `TieredBillingResult`,
  `estimate_tiered_billing_snapshot()`, and `compute_tiered_quota()` for the
  pure Rust pre-consume/post-consume tiered settlement boundary:
  - freezes expression string, v1 version, group ratio, estimated tokens,
    estimated cost, estimated tier, and estimated quota;
  - re-runs the frozen expression against actual token params;
  - applies `quota = exprOutput / 1_000_000 * QuotaPerUnit * groupRatio`;
  - reports matched tier, tier crossing, final quota, refund quota, and
    additional quota.

## Boundary

This is not wired into Worker quota mutation yet. The Worker still records
`quota = 0` audit logs with `other.billing_pending = true`.

Do not decrement user or token quota from the Worker until the migration ports
and verifies these remaining Go billing behaviors:

- expression compile/cache metadata and validation;
- broader Go/Rust golden parity tests for expression edge cases;
- request-rule handling for expressions stored with `|||`;
- Worker relay wiring for quota pre-consume, final settlement, quota mutation,
  and error fallback;
- matched tier metadata injection for usage-log display.

## Compatibility Tests

The Rust tests cover the most important Go-compatible arithmetic:

- quota rounding edge cases such as `0.5 -> 1` and `-0.5 -> -1`;
- expression output conversion to quota;
- prompt/completion flat price calculation;
- expression version parsing and variable detection while ignoring string
  literals;
- expression execution for simple flat prices, conditional tiers, math helpers,
  multimodal variables, request `param()`/`header()` probes, missing-field `nil`
  handling, and time helper ranges;
- tiered pre-consume snapshots, group-ratio application, actual-use
  settlement, refund/additional deltas, request-probe preservation, and
  crossed-tier detection;
- GPT/OpenAI and Claude tiered token normalization, including `len`,
  cache/image/audio input tokens, and image/audio output tokens;
- refund versus additional-consumption settlement deltas.
