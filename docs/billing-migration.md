# Billing Migration

## Current Rust State

`crates/billing` now contains the first pure Rust billing primitives:

- `DEFAULT_QUOTA_PER_UNIT = 500_000.0`, matching the Go setting default.
- `quota_round()`, matching Go `math.Round` half-away-from-zero behavior.
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
- `p` / `c` token normalization based on expression variables;
- `len` total-context semantics;
- request-aware expression helpers such as `param()` and `header()`;
- group ratio application;
- matched tier metadata injection for usage-log display.

## Compatibility Tests

The Rust tests cover the most important Go-compatible arithmetic:

- quota rounding edge cases such as `0.5 -> 1` and `-0.5 -> -1`;
- expression output conversion to quota;
- prompt/completion flat price calculation;
- refund versus additional-consumption settlement deltas.
