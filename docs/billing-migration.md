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

The Worker now reads Go-compatible D1 billing options. For a model configured
with tiered-expression billing, it freezes a request-time preflight snapshot
before upstream relay using the original request body, request probes, group
ratio, and a lightweight prompt/completion token estimate. For non-streaming
OpenAI-compatible requests, it reserves the estimated wallet/token quota before
forwarding upstream.

For successful non-streaming OpenAI-compatible tiered-expression responses with
usage metadata, it settles final tiered quota against that frozen snapshot and
applies only the delta from pre-consumed quota:

- before upstream: decrement `users.quota`, decrement `tokens.remain_quota`,
  and increment `tokens.used_quota` by the estimated quota;
- after upstream: refund or additionally debit `users.quota`,
  `tokens.remain_quota`, and `tokens.used_quota` by the settlement delta;
- after upstream: increment `users.used_quota`, `users.request_count`, and
  `channels.used_quota` by the final quota;
- write the final log `quota` and `other.tiered_billing` metadata.

If upstream forwarding fails or a non-streaming response has no billable usage,
the Worker refunds the reserved wallet/token quota and records
`other.tiered_billing_refund`. If post-response expression evaluation fails
after reserve, it falls back to the pre-consumed quota and records
`other.tiered_billing_fallback`, matching the Go fallback behavior.

If the tiered computation succeeds but D1 quota mutation cannot be applied, the
Worker leaves `quota = 0`, keeps `other.billing_pending = true`, and records
the computed result under `other.tiered_billing_shadow` with an error.

Do not expand Worker quota mutation beyond this non-streaming tiered-expression
path until the migration ports and verifies these remaining Go billing
behaviors:

- expression compile/cache metadata and validation;
- broader Go/Rust golden parity tests for expression edge cases;
- request-rule handling for expressions stored with `|||`;
- tokenizer/media parity for request-time token estimation;
- streaming reserve and settlement once full stream usage is available;
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
- Worker request-body token estimation, request-time tiered preflight
  snapshots, and settlement deltas against frozen snapshots;
- Worker tiered reserve metadata, fallback metadata, and refund metadata for
  non-streaming pre-consume paths;
- GPT/OpenAI and Claude tiered token normalization, including `len`,
  cache/image/audio input tokens, and image/audio output tokens;
- refund versus additional-consumption settlement deltas.
