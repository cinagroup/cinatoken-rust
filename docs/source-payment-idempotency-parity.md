# Source Payment And Webhook Idempotency Parity (G4/G5/G7)

Date: 2026-07-04

Status: canonical, source-derived specification of the Go top-up / payment
order model, the webhook credit flow, and the idempotency guarantees. Payment
double-credit and missed-credit are hard rollback triggers
(`docs/cutover-rollback-runbook.md`); this file pins the exact rules so the Rust
implementation cannot double-credit or silently drop a payment.

## Review findings (2026-06-25, `admin_payment.rs::stripe_webhook`)

The Rust Stripe webhook has the two-layer idempotency shape but two real
**missed-credit** bugs (customer paid, never credited; permanent after retry):

1. **Non-atomic credit.** `complete_topup` (status 0->1) and `increase_user_quota`
   are separate D1 calls; a crash between them leaves the top-up completed but
   uncredited, and the retry is deduped.
2. **Idempotency gated on event-dedup before the credit.** `insert_payment_event`
   runs before `complete_topup`; if the credit then fails, the retry hits the
   event-dedup early-return and the credit never runs.

Fix: anchor idempotency on the conditional credit, make it atomic, demote event
dedup to non-gating. **A first cut keyed the credit on `(status=1 AND
complete_time=?now)`; that double-credits on a same-second duplicate delivery**
(unix `complete_time` is second-resolution, so two webhooks in the same second
both match — confirmed in sqlite: credit went 1000 -> 2000). The shipped fix uses
a dedicated `credited` flag set AFTER the credit, in the same atomic batch
(migration `0005_topups_credited.sql`) —
```text
batch:
  s1: UPDATE topups SET status=1, complete_time=?now WHERE trade_no=? AND status=0
  s2: UPDATE users SET quota = quota + COALESCE(
        (SELECT amount FROM topups WHERE trade_no=? AND status=1 AND credited=0), 0)
        WHERE id = (SELECT user_id FROM topups WHERE trade_no=? AND status=1 AND credited=0)
  s3: UPDATE topups SET credited=1 WHERE trade_no=? AND status=1 AND credited=0
  return changes(s1) > 0
```
Replay (any timing) -> s1 no-ops and `credited=1` makes s2/s3 no-op (no
double-credit, incl. same-second); transient failure -> topup stays status=0 and
the retry credits exactly once. Relies only on intra-transaction visibility, not
on `changes()` mid-batch (which would credit nobody if D1 doesn't expose it).
The three idempotency scenarios (same-second replay, post-backfill late replay,
failed-topup) are sqlite-verified; still confirm against staging D1 before paid
cutover (D1 batch atomicity is not unit-testable here).

Checkout (`stripe_pay`) also had:
3. **Checkout created before the top-up row, with the row's error ignored**
   (`let _ = create_topup`) -> a paid checkout could have no creditable record.
4. **Hardcoded `cinatoken.example` redirect URLs** -> customers land on a dead
   domain after paying.

**Status: all four fixed + the same-second double-credit hardened (2026-06-26)**
in `admin_payment.rs` + `d1_repositories.rs` + `migrations/d1/0005_topups_credited.sql`:
atomic 3-statement `complete_topup_and_credit` batch with a `credited` anchor
(same-second-replay safe); event-dedup demoted to non-gating; top-up row created
first with error handling; redirects built from `FRONTEND_BASE_URL` +
`encode_uri_component`; fixed-width `trade_no` suffix. Worker tests + wasm green;
idempotency sqlite-verified. **Still confirm the batch on staging D1 before paid
cutover.**

## Source Of Truth

- `model/topup.go` — `TopUp`, `Recharge` (Stripe), `RechargeCreem`,
  `RechargeWaffo`, `RechargeWaffoPancake`, `ManualCompleteTopUp`,
  `UpdatePendingTopUpStatus`.
- `controller/topup_stripe.go` etc. — webhook handlers and signature checks.
- `model/subscription.go` — subscription order parallel.
- D1: `migrations/d1/0003_topups.sql` (`topups`), `0005_topups_credited.sql`
  (`credited` anchor), `0015_topups_payment_provider.sql`
  (`payment_provider`), and `0001_core.sql` (`payment_events`,
  `subscription_orders`).

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
`0003_topups.sql`, `0005_topups_credited.sql`, and
`0015_topups_payment_provider.sql`):

1. `payment_events` `UNIQUE(provider, event_id)` — insert the webhook event
   first; a duplicate event id is rejected, deduping provider re-deliveries at
   the event level.
2. `topups` conditional credit: `UPDATE topups SET status=1, complete_time=?
   WHERE trade_no=? AND status=0` — D1/SQLite serializes writes globally, so this
   single statement is an atomic compare-and-swap. **The handler must branch on
   rows-affected**: 1 row -> credit the user (same logical step); 0 rows ->
already completed, no-op. No `FOR UPDATE` is needed or available.

2026-07-04 update: the Worker must also verify that the same D1 batch changed
the quota-credit statement and the `credited=1` marker. A status flip without a
matching credit/mark is a partial completion error and must not be ACKed as a
successful webhook. Provider callbacks such as Epay also guard the compare-and-
swap on `payment_provider` and expected money.

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

Historical status (verified 2026-06-25): `crates/payments/src/lib.rs` was a
**Stripe foundation** — `parse_stripe_signature` + HMAC-SHA256 verify, the
`STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300` window, the `PaymentEvent` +
`was_processed`/`mark_processed` event-dedup trait, `StripeConfig` loaded from D1
options, and `money_to_quota`. Two parity notes:
- **`money_to_quota` uses `.round()`** (`money * unit_price * 500_000` rounded),
  but Go truncates toward zero (`int(...)` / `decimal.IntPart()`). This is a real
  divergence — fix to truncate to match Go.
- 2026-07-04 delta: Stripe wallet checkout/webhook, Epay wallet
  checkout/callback, and Waffo Pancake wallet checkout/webhook now use
  provider-aware topup rows and D1 credited-anchor settlement. Creem/Waffo
  wallet providers, subscription checkout/callback providers, and
  `ValidateRedirectURL` parity are still pending.

Current Epay wallet details:

- `POST /api/user/pay` precomputes `topups.amount` as the final quota to credit,
  matching Go's token-display, group-ratio, unit-price, and discount rules at
  order-creation time.
- `GET/POST /api/user/epay/notify` verifies the MD5 signature before any write,
  requires a `TRADE_SUCCESS` money/provider match, and calls
  `complete_topup_and_credit_for_provider`. POST callbacks require a valid
  `Content-Length` not exceeding 16 KiB before the Worker reads the body.
- Verified replays are normalized to `"success"` no-op responses; staging D1
  replay smoke is still required before paid-traffic cutover. Signature-valid
  mismatches or partial complete/credit/mark batches return `"fail"` instead of
  being ACKed.

Current Waffo Pancake wallet details:

- `POST /api/user/waffo-pancake/pay` creates the D1 pending topup before
  creating the external checkout session. It uses Go-compatible
  `WAFFO_PANCAKE-{user}-{UnixMilli}-{rand6}` trade numbers,
  `cinatoken-user-{id}` buyer identity, a two-decimal USD price snapshot, and
  the SDK-compatible authenticated checkout pair
  `/v1/actions/auth/issue-session-token` +
  `/v1/actions/checkout/create-session`.
- Rust keeps the D1 invariant that `topups.amount` is the final quota to
  credit. For Waffo Pancake token-display mode this means order creation
  reproduces Go's `normalizeWaffoPancakeTopUpAmount` + `RechargeWaffoPancake`
  result: `max(IntPart(amount / QuotaPerUnit), 1) * QuotaPerUnit`.
- `POST /api/waffo-pancake/webhook/:env` verifies `X-Waffo-Signature`
  (`t=...,v1=...`) as RSA-SHA256/PKCS#1 v1.5 over `t + "." + raw_payload`,
  enforces a 5-minute timestamp window, uses the Waffo test/prod public key for
  the route env, and then enforces `event.mode == :env`.
- Only `order.completed` wallet events credit. The handler rejects
  signature-valid but unresolvable events with a recorded `payment_events` row
  and `200 OK` (permanent mismatch, no provider retry), checks local
  `payment_provider == "waffo_pancake"`, verifies
  `merchantProvidedBuyerIdentity == cinatoken-user-{topup.user_id}`, and checks
  the event amount against the stored order money when present.
- First-time credits run through
  `complete_topup_and_credit_for_provider`; duplicate successful deliveries are
  replayed as `200 OK` no-ops only when the row is already success+credited with
  matching provider/method/money. Waffo Pancake subscription events are recorded
  as `subscription_deferred` until subscription settlement is migrated.

Checklist:

1. Keep per-provider signature verification before any write. Done for Stripe,
   Epay wallet topups, and Waffo Pancake wallet topups; pending for
   Creem/Waffo and subscription providers.
2. Keep `payment_events` as non-gating audit/dedup evidence and anchor credit on
   `topups` conditional credited batches. Done for Stripe, Epay wallet topups,
   and Waffo Pancake wallet topups; provider-specific replay fixtures still
   need staging D1 proof.
3. Implement per-provider quota formulas with truncation. Done for Epay wallet
   order creation; Stripe `money_to_quota` still needs truncation parity review.
4. Normalize webhook replays to 200 no-op and add replay tests that credit
   exactly once across duplicate deliveries. Unit coverage exists for helper
   parity; staging D1 replay smoke remains required.
5. Add amount/currency/product/env match checks. Epay wallet checks provider and
   money; currency/product/env checks apply to remaining providers.
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
