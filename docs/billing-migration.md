# Billing Migration

## Current Rust State

`crates/billing` now contains the first pure Rust billing primitives:

- `DEFAULT_QUOTA_PER_UNIT = 500_000.0`, matching the Go setting default.
- `quota_round()`, matching Go `math.Round` half-away-from-zero behavior.
- `parse_expr_version()` with `v1:` support and v1 as the default version.
- `detect_billing_expr_variables()` for the billing variables that drive
  token normalization.
- `expr_hash_string()` and `compile_billing_expr_metadata()` for Go-compatible
  expression cache metadata:
  - SHA-256 hex hashes over the exact stored expression string, matching Go
    `ExprHashString()`;
  - compile-style validation that parses the base expression and `|||`
    request-rule multiplier, then rejects unknown variables/functions and bad
    function arity before pre-consume quota mutation;
  - metadata for expression version, base expression, request-rule expression,
    and billing variable usage.
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
- `split_billing_expr_request_rule()` and request-rule multiplier execution for
  expressions stored as `billing_expr|||request_rule_expr`, preserving the base
  tier trace while applying the request-aware multiplier to the final cost.
- `RequestInput`, `TraceResult`, and `ExprRun` for passing request probes and
  carrying matched-tier metadata.
- `BillingSnapshot` for freezing estimated inputs before settlement.
- `TieredBillingSnapshot`, `TieredBillingResult`,
  `estimate_tiered_billing_snapshot()`, and `compute_tiered_quota()` for the
  pure Rust pre-consume/post-consume tiered settlement boundary:
  - freezes expression string, expression hash, v1 version, group ratio,
    estimated tokens, estimated cost, estimated tier, and estimated quota;
  - re-runs the frozen expression against actual token params;
  - applies `quota = exprOutput / 1_000_000 * QuotaPerUnit * groupRatio`;
  - reports matched tier, tier crossing, final quota, refund quota, and
    additional quota.

## Boundary

The Worker now reads Go-compatible D1 billing options. For a model configured
with tiered-expression billing, it freezes a request-time preflight snapshot
before upstream relay using the original request body, request probes, group
ratio, a prompt/completion token estimate, and visible request-body media
fallback counts. For OpenAI-compatible, native Anthropic, and native Gemini
tiered requests, including streaming chat completions, Anthropic Messages,
Gemini generateContent, Gemini streamGenerateContent, and Gemini embedding
requests, and Gemini countTokens requests, it reserves the estimated
wallet/token quota before forwarding upstream. For streaming chat completions,
Anthropic Messages, and native Gemini streams, it tees the upstream response,
streams one branch to the client, and consumes the audit branch in `wait_until`
with an incremental SSE usage parser.

For successful tiered-expression responses with usage metadata, including
nested cached/cache-creation and image/audio token details, it rebuilds actual
token parameters from the frozen expression's variable usage, settles final
tiered quota against that frozen snapshot, and applies only the delta from
pre-consumed quota:

- before upstream: decrement `users.quota`, decrement `tokens.remain_quota`,
  and increment `tokens.used_quota` by the estimated quota;
- after upstream or full stream consumption: refund or additionally debit `users.quota`,
  `tokens.remain_quota`, and `tokens.used_quota` by the settlement delta;
- after upstream or full stream consumption: increment `users.used_quota`,
  `users.request_count`, and `channels.used_quota` by the final quota;
- write the final log `quota`, `other.tiered_billing` metadata, and
  Go-compatible top-level usage-log display fields `billing_mode`, `expr_b64`,
  and `matched_tier`.

`expr_b64` contains the base billing expression only. The Worker continues to
record request-rule presence as metadata without writing the request-rule body
into logs.

If upstream forwarding fails or a response has no billable usage, the Worker
refunds the reserved wallet/token quota and records
`other.tiered_billing_refund`. If post-response expression evaluation fails
after reserve, it falls back to the pre-consumed quota and records
`other.tiered_billing_fallback`, matching the Go fallback behavior.

If the tiered computation succeeds but D1 quota mutation cannot be applied, the
Worker leaves `quota = 0`, keeps `other.billing_pending = true`, and records
the computed result under `other.tiered_billing_shadow` with an error.

Do not expand Worker quota mutation beyond tiered pre-consume reserve and
post-response/post-stream delta settlement until the migration ports and
verifies these remaining Go billing behaviors:

- broader Go/Rust golden parity tests for expression edge cases;
- exact tokenizer counts plus image dimension and audio duration parity for
  request-time token estimation.

## Compatibility Tests

The Rust tests cover the most important Go-compatible arithmetic:

- quota rounding edge cases such as `0.5 -> 1` and `-0.5 -> -1`;
- expression output conversion to quota;
- prompt/completion flat price calculation;
- expression version parsing and variable detection while ignoring string
  literals;
- Go-compatible SHA-256 expression hashing, compile metadata, and compile-style
  validation for inactive branches and request-rule expressions;
- expression execution for simple flat prices, conditional tiers, math helpers,
  multimodal variables, request `param()`/`header()` probes, missing-field `nil`
  handling, `|||` request-rule multipliers, and time helper ranges;
- tiered pre-consume snapshots, group-ratio application, actual-use
  settlement, refund/additional deltas, request-probe preservation,
  `|||` request-rule preservation, and crossed-tier detection;
- Worker request-body token estimation, request-time tiered preflight
  snapshots, visible media fallback counts, usage-detail token normalization,
  and settlement deltas against frozen snapshots;
- Worker tiered reserve metadata, fallback metadata, and refund metadata for
  pre-consume paths;
- Worker tiered usage-log display metadata, including Go-compatible base64
  expression encoding and matched-tier injection without logging request-rule
  bodies;
- OpenAI-compatible JSON/SSE usage parsing plus native Anthropic and Gemini
  usage parsing for cached/cache-creation and image/audio token details, final
  streaming usage chunks, CRLF streams, invalid events, split byte chunks,
  `[DONE]`, nested response usage metadata, Gemini generate
  `usageMetadata`, Gemini embedding `usageMetadata`, and Gemini countTokens
  `totalTokens`;
- GPT/OpenAI and Claude tiered token normalization, including `len`,
  cache/image/audio input tokens, and image/audio output tokens;
- Go/Rust golden parity fixtures for GLM-style multi-condition division,
  Claude tier boundaries, Claude cache split expressions, legacy cache-field
  ignoring, `len` tier conditions after cache subtraction, ratio-equivalent
  quota conversion, nested/array/missing request probes, request probe
  multipliers, common frontend time zones for time helpers, math helpers,
  multimodal variables, and used-variable detection;
- refund versus additional-consumption settlement deltas.
