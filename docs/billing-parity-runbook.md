# Billing Parity Runbook

Date: 2026-06-22

Status: production billing parity and shadow settlement control document.

## Purpose

Use this runbook to prove that Rust billing behavior is compatible with the
Go/VPS deployment before Rust owns paid quota, subscription, or payment
settlement.

Required source reference was read before this document was created:

```text
C:\cinagroup\cinatoken\pkg\billingexpr\expr.md
Read date: 2026-06-22
```

Do not make a billing-expression implementation or production-status change
without re-reading that source document for the change.

## Compatibility Contract

The source billing expression system defines the contract. The Rust migration
must preserve these rules:

- One expression, one truth: the stored expression is the auditable billing
  contract.
- Expressions are self-contained. They cannot depend on mutable external state
  except the documented request probes and time helpers.
- Supported billing variables include `p`, `c`, `len`, `cr`, `cc`, `cc1h`,
  `img`, `ai`, `img_o`, and `ao`.
- For OpenAI/GPT-style token normalization, `p` and `c` exclude cache/image/audio
  subcategories only when the expression references those subcategory
  variables.
- `len` is always total input context and is the correct variable for tier
  conditions over full context length.
- Claude input semantics are text-oriented and must not subtract non-existent
  OpenAI-style categories.
- Request rules after `|||` are multipliers applied separately from the base
  billing expression.
- Pre-consume freezes the request input, expression, hash, group ratio, estimate,
  and matched tier.
- Settlement uses actual upstream usage against the frozen snapshot.
- Logs can include billing mode, base expression base64, and matched tier, but
  must not write request-rule bodies.

## Ownership Modes

| Mode | Go/VPS Behavior | Rust Behavior | Production Use |
| --- | --- | --- | --- |
| Observe | Go applies all quota/payment deltas | Rust computes metadata only | Local/staging development |
| Shadow | Go applies deltas | Rust computes frozen estimate and final delta, logs comparison keys | Required before customer canary |
| Scoped apply | Rust applies deltas for selected internal/canary tokens | Go remains rollback target | Scenario A/B canary only after shadow passes |
| Full apply | Rust owns quota/payment/subscription deltas | Go is rollback archive | Scenario C/D only after all gates pass |

The default production migration mode is Shadow until this runbook passes for
the selected scope.

## Golden Fixture Matrix

The source-grounded engine contract and a test-by-test map of the 56 Go
`billingexpr` golden tests to these fixture families (with Rust coverage status
and a prioritized gap checklist) is in `docs/source-billing-expr-parity.md`. Use
it to decide which fixtures are still missing; this section defines the families.

Add fixtures before enabling a billing behavior in production.

| Fixture Family | Required Cases |
| --- | --- |
| Flat text pricing (non-tiered) | Prompt-only, completion-only, mixed prompt/completion, zero usage. Per-call vs per-token, completion/cache/image/audio ratios, default-37.5 tri-state, free model — per `docs/source-pricing-ratio-parity.md`. |
| Tiered expressions | Boundary below tier, at tier, above tier, crossed tier after actual usage. |
| `len` semantics | Full context tiering, cache-heavy prompts, Claude long context. |
| Cache categories | `cr`, `cc`, `cc1h`, expressions that do and do not reference cache variables. |
| Image/audio categories | Input/output image tokens, audio input/output tokens, no double subtraction. |
| Request probes | `param()`, `header()`, `has()`, missing field, null field, array/nested paths. |
| Request-rule split | `billing_expr|||request_rule_expr`, multiplier true/false, redaction of rule body. |
| Math helpers | `max`, `min`, `abs`, `ceil`, `floor`, division and comparison edge cases. |
| Time helpers | UTC, common frontend Asia time zones, boundary hours/days. |
| Group ratio | ratio 1.0, fractional ratio, large ratio, quota round half-away-from-zero. |
| Invalid expressions | Unknown variable/function, bad arity, inactive branch validation, syntax errors. |
| Provider usage | OpenAI-compatible JSON/SSE, Anthropic Messages, Gemini generate/stream/embed/count, rerank. |
| Failure paths | Upstream error, timeout, missing final usage, client disconnect, D1 mutation failure. |
| Subscription/payment | Pre-consume record replay, idempotent webhook replay, refund/additional debit. |

Each fixture should record:

```text
Case ID:
Source expression:
Request-rule expression:
Provider family:
Request probes:
Estimated tokens:
Actual usage:
Group ratio:
Go expected cost:
Go expected quota:
Rust estimated quota:
Rust final quota:
Rust refund/additional quota:
Matched tier:
Expected log fields:
Pass/fail:
```

## Shadow Settlement

Shadow mode must compare Go-applied settlement with Rust-computed settlement
without mutating customer balances from Rust.

Required correlation keys:

- request ID;
- user ID or fingerprint;
- token ID or fingerprint;
- channel ID;
- provider family;
- model before and after mapping;
- expression hash;
- matched tier;
- upstream usage object hash;
- Go quota delta;
- Rust quota delta.

Shadow report fields:

```text
Window:
Traffic selection:
Request count:
Matched request count:
Unmatched Go requests:
Unmatched Rust requests:
Exact quota matches:
Accepted differences:
Unexplained differences:
Maximum absolute delta:
Maximum relative delta:
Cached-token cases:
Image/audio cases:
Streaming cases:
Missing-usage cases:
Abort decision:
Approvers:
```

Suggested thresholds for first customer canary:

- 100% of sampled P0 requests have correlation keys.
- 0 unexplained positive charge deltas.
- 0 negative-balance or double-charge cases.
- 0 request-rule body leaks in logs.
- No unexplained absolute delta above 1 quota unit for ordinary text requests.
- Any tolerated rounding difference must have a fixture and owner approval.

The threshold can be stricter for paid canary; it cannot be weaker without a
release-owner exception.

## Production Billing Gates

### G4-S1: Expression Parity

Pass criteria:

- Golden fixtures cover every production expression pattern selected for
  canary.
- Rust validates unknown variables/functions and bad function arity before
  pre-consume mutation.
- Expression hash and base64 log fields match Go-compatible expectations.
- Request-rule body remains redacted.

### G4-S2: Request Estimate Parity

Pass criteria:

- Prompt/completion estimates are within agreed tolerance for selected models.
- Image/audio fallback counts are documented.
- Exact tokenizer/image/audio duration gaps have owner and mitigation.
- Cache/image/audio categories are not double-counted in `p` or `c`.

### G4-S3: Reserve And Refund

Pass criteria:

- Reserve debits `users.quota`, `tokens.remain_quota`, and
  `tokens.used_quota` only for approved modes.
- Upstream error refunds reserved quota.
- Timeout and client disconnect behavior is deterministic and tested.
- Missing final usage refunds or marks pending exactly as documented.

### G4-S4: Actual Settlement

Pass criteria:

- Non-stream JSON usage settles final quota.
- SSE final usage settles final quota after the audit branch completes.
- Tier crossing produces refund or additional debit correctly.
- D1 mutation failure marks billing pending and does not hide the computed
  shadow result.

### G4-S5: Subscription And Payment

Pass criteria:

- Subscription pre-consume records have schema, import, and replay tests.
- Webhook signatures are verified.
- Payment events are idempotent.
- Double-credit and missed-credit tests pass.
- Refund/reversal path is documented.

## Abort Triggers

Abort billing canary immediately on:

- any balance or token remaining quota corruption;
- any double charge;
- any missed credit or double credit;
- unexplained Rust quota delta above threshold;
- request-rule body leakage;
- provider usage parser corruption;
- D1 settlement mutation failure above threshold;
- inability to correlate Go and Rust request IDs;
- operator inability to disable a token/channel quickly.

## Evidence Flow

Local:

```powershell
cargo test -p cinatoken-worker --lib
bun run check
```

Staging:

```text
Run JSON relay smoke.
Run SSE relay smoke.
Run failure-mode smoke.
Export redacted billing shadow report.
Attach report summary to docs/verification.md.
```

Production shadow:

```text
Select internal or low-risk customer traffic.
Keep Go/VPS as settlement source.
Compute Rust settlement and logs only.
Compare by request ID and expression hash.
Promote only if thresholds pass.
```

Production apply:

```text
Enable scoped Rust settlement for selected tokens/groups.
Watch abort triggers continuously.
Record every promotion decision.
Keep Go/VPS hot for rollback and reconciliation.
```

## Redacted Billing Report Template

```text
Report:
Commit:
Window:
Mode:
Traffic selection:
Provider families:
Models:
Expression hashes:
Fixture set:
Request count:
Exact matches:
Accepted differences:
Unexplained differences:
Largest absolute delta:
Largest relative delta:
Reserve/refund failures:
Payment/subscription cases:
Log redaction result:
Go/no-go decision:
Approvers:
```

## Realtime Per-Response Matrix

The billing unit is a client `response.create`, not the WebSocket session.
Each row below must be exercised against migration 0019 and reconciled with the
source Go reserve/settle/refund lifecycle.

| Case | Required result |
| --- | --- |
| First response | Freeze request-aware snapshot, reserve before forwarding, settle actual usage once. |
| Two responses on one socket | Bind distinct `response.created` identities, complete them out of order, and retain two correct settlements, request counts, and audit rows. |
| Server/Semantic VAD | Automatic response creation and idle response timeouts are disabled; VAD events remain usable and the client sends explicit `response.create`. |
| Duplicate client event | Same hashed identity is rejected; no second reserve or upstream forward. |
| Duplicate upstream terminal event | Existing terminal response identity is detected before any fallback binding; the next reservation remains untouched. |
| Insufficient user/token quota | Entire D1 reservation batch rolls back and event is not forwarded. |
| Tier increase/decrease | Final delta is applied against that response's own reserved quota. |
| Missing usage | Reservation transitions to refunded once; no used/channel quota or consume log. |
| Forward/connect/disconnect failure | Every unconsumed reservation is refunded once. |
| D1 settlement failure | Reservation remains reserved and a private retry record is persisted. |
| Two failed settlements | Both records survive; one alarm processes earliest due work without overwrite; exhausted work refunds its reservation idempotently. |
| Alarm replay after eviction | D1/DO state recovers idempotently and neither response is charged twice. |

Evidence must include reservation state, response binding, replay state,
user/token/channel deltas, request count, audit count, retry count, and
redaction checks. Raw request JSON and frozen expressions stay out of the
report, and terminal reservation rows must show private recovery fields
cleared.
