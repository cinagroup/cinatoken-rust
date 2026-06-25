# Source Payment And Webhook Idempotency Parity (G4/G5/G7)

Date: 2026-06-25

Status: canonical, source-derived specification of the Go top-up / payment
order model, the webhook credit flow, and the idempotency guarantees. Payment
double-credit and missed-credit are hard rollback triggers
(`docs/cutover-rollback-runbook.md`); this file pins the exact rules so the Rust
implementation cannot double-credit or silently drop a payment.

## Source Of Truth

- `model/topup.go` — `TopUp`, `Recharge` (Stripe), `RechargeCreem`,
  `RechargeWaffo`, `RechargeWaffoPancake`, `ManualCompleteTopUp`,
  `UpdatePendingTopUpStatus`.
- `controller/topup_stripe.go` etc. — webhook handlers and signature checks.
- `model/subscription.go` — subscription order parallel.
- D1: `migrations/d1/0003_topups.sql` (`topups`), `0001_core.sql`
  (`payment_events`, `subscription_orders`).

## Order Model And State Machine

`TopUp`: `id, user_id, amount (int64), money (float64), trade_no (UNIQUE),
payment_method, payment_provider, create_time, complete_time, status`.

- `trade_no` is the unique internal order id (`ref_ + hash`); the primary
  idempotency key.
- Statuses: `pending -> success`; D1 encodes `0=pending, 1=success, 2=failed,
  3=expired`.
- Providers/methods: `stripe`, `creem`, `waffo`, `waffo_pancake`, `epay`,
  `balance`.

## Idempotency Mechanism (the rule that prevents double-credit)

**Go**: credit runs inside a DB transaction that takes a row lock and re-checks
status:

```text
tx: SELECT ... FOR UPDATE WHERE trade_no = ?
    if status == success: return (idempotent no-op)        # Waffo/WaffoPancake/Manual
    if status != pending: return error                      # wrong state
    set status=success, complete_time=now
    UPDATE users SET quota = quota + <computed> WHERE id = user_id
```

The `FOR UPDATE` lock serializes concurrent webhook deliveries; the status guard
makes a replay a no-op (or error). Quota is added in the **same transaction** as
the status flip, so credit and completion are atomic.

**Rust/D1** already implements a stronger **two-layer** model (see
`0003_topups.sql` header):

1. `payment_events` `UNIQUE(provider, event_id)` — insert the webhook event
   first; a duplicate event id is rejected, deduping provider re-deliveries at
   the event level.
2. `topups` conditional credit: `UPDATE topups SET status=1, complete_time=?
   WHERE trade_no=? AND status=0` — D1/SQLite serializes writes globally, so this
   single statement is an atomic compare-and-swap. **The handler must branch on
   rows-affected**: 1 row -> credit the user (same logical step); 0 rows ->
   already completed, no-op. No `FOR UPDATE` is needed or available.

This is a deliberate, correct translation: Go's read-lock-check-write becomes
D1's conditional-update-and-check-rows-affected, plus event-level dedup.

## Webhook Flow

Anonymous routes (no auth); correctness depends entirely on signature
verification, performed **before** any state change:

- Stripe: `webhook.ConstructEventWithOptions(payload, Stripe-Signature,
  StripeWebhookSecret)`; on `checkout.session.completed` -> `Recharge(ref,
  customerId, ip)`.
- Creem/Waffo/Waffo-Pancake/Epay: each verifies its own signature scheme (HMAC /
  MD5 sign / provider SDK) then calls its `Recharge*`.
- Waffo-Pancake webhook path is `:env`-scoped (`/api/waffo-pancake/webhook/:env`)
  and the handler enforces the test/prod env match.

## Per-Provider Quota Formula (must match exactly)

| Provider | Credited quota | Note |
| --- | --- | --- |
| Stripe (`Recharge`) | `Money * QuotaPerUnit` (float) | `Money` is group-ratio-converted USD |
| Stripe (`ManualCompleteTopUp`) | `decimal(Money) * QuotaPerUnit` `.IntPart()` | decimal, **truncates** |
| Creem | `Amount` (raw int64) | already a quota amount |
| Waffo / Waffo-Pancake | `decimal(Amount) * QuotaPerUnit` `.IntPart()` | decimal, **truncates** |
| Epay / others (Manual) | `decimal(Amount) * QuotaPerUnit` `.IntPart()` | decimal, **truncates** |

`.IntPart()` **truncates toward zero**, it does not round. Rust must truncate,
not round, the credited quota.

## Parity-Critical Findings

1. **Idempotency translation must use rows-affected.** The Rust handler decides
   "credit vs already-done" from the conditional UPDATE's affected-row count, not
   a separate read (which would race). Pair it with `payment_events` event dedup.
2. **Replay should be a 200 no-op, not an error.** Go is inconsistent: Waffo/
   WaffoPancake/Manual return success on already-completed, while Stripe/Creem
   `Recharge` return an *error* (still no double-credit, because status !=
   pending). For webhooks, returning an error invites provider retries. Rust
   should normalize replays to **200 OK no-op** (0 rows affected) and document
   this as an intentional improvement.
3. **Truncation, not rounding.** Match Go `decimal.IntPart()` truncation; using
   round would create ±1 quota drift on credits.
4. **Decimal vs float.** Go mixes `shopspring/decimal` (most paths) and raw float
   (`Recharge` Stripe). Rust should compute credits in integer/decimal-safe math
   to avoid float drift, and reconcile the small Stripe-float vs decimal-path
   difference during shadow billing.
5. **Strict callback match** (migration-plan §7.13): verify amount, currency,
   product/plan id, and env before crediting; a signature-valid but
   amount/env-mismatched event must not credit.
6. **Where is `amount` computed?** D1 `topups.amount` is commented "quota to
   credit on completion". If Rust precomputes final quota into `amount` at order
   creation, the per-provider formula above moves to order-creation time —
   ensure parity there and that the webhook simply credits `amount`.
7. **Subscription orders are a parallel flow.** `subscription_orders` has its own
   `order_no UNIQUE` + status; apply the same event-dedup + conditional-update
   idempotency, and keep subscription funding-source settlement separate from
   wallet top-ups.
8. **Credit and completion must be atomic.** Never flip status in one statement
   and credit in another without the conditional guard; a crash between them
   double-credits on retry.

## Rust Status And Checklist

Per the matrices, payments/subscriptions are `Planned`. The schema
(`topups`, `payment_events`, `subscription_orders`) and the idempotency design
exist; the handlers do not. Checklist:

1. Implement per-provider signature verification (Stripe HMAC, Creem, Waffo,
   Waffo-Pancake `:env`, Epay MD5) before any write.
2. Implement `payment_events` insert-dedup + `topups` conditional credit
   (`WHERE status=0`, branch on rows-affected).
3. Implement per-provider quota formulas with truncation; decide `amount`
   precompute-at-creation vs compute-at-webhook and prove parity.
4. Normalize replays to 200 no-op; add a webhook-replay test that credits exactly
   once across N duplicate deliveries.
5. Add amount/currency/product/env match checks.
6. Mirror for `subscription_orders`; keep subscription settlement funding-source
   correct (`docs/billing-parity-runbook.md`).
7. Admin manual-complete (`ManualCompleteTopUp`) and `AdminCompleteTopUp` route
   parity with audit.

## Wire-In

- `docs/production-readiness-matrices.md` "Redemptions, topups, subscriptions,
  payment webhooks" route row and the Billing matrix payment/subscription row
  reference this file.
- `docs/data-migration-runbook.md` Wave 3 (billing/payment) consumes the order
  model and idempotency keys.
- `docs/billing-parity-runbook.md` Subscription/payment fixtures consume the
  replay/idempotency cases.
- Double-credit / missed-credit remain rollback triggers in
  `docs/cutover-rollback-runbook.md`.
