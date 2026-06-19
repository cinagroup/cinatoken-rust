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
- `BillingSnapshot` for freezing estimated inputs before settlement.

## Boundary

This is not wired into Worker quota mutation yet. The Worker still records
`quota = 0` audit logs with `other.billing_pending = true`.

Do not decrement user or token quota from the Worker until the full migration
ports these Go billing behaviors:

- expression compile/cache and validation;
- full expression evaluation with `tier()`, `param()`, `header()`, math helpers,
  and time helpers;
- request-aware expression helpers such as `param()` and `header()`;
- group ratio application;
- matched tier metadata injection for usage-log display.

## Compatibility Tests

The Rust tests cover the most important Go-compatible arithmetic:

- quota rounding edge cases such as `0.5 -> 1` and `-0.5 -> -1`;
- expression output conversion to quota;
- prompt/completion flat price calculation;
- expression version parsing and variable detection while ignoring string
  literals;
- GPT/OpenAI and Claude tiered token normalization, including `len`,
  cache/image/audio input tokens, and image/audio output tokens;
- refund versus additional-consumption settlement deltas.
