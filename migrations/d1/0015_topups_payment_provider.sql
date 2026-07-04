-- Migration 0015: explicit topup payment provider.
--
-- Go `model.TopUp` stores both the customer-visible payment method (alipay,
-- wxpay, stripe, etc.) and the gateway/provider family (epay, stripe, creem,
-- waffo, waffo_pancake). The initial Rust Stripe-only topups table only had
-- `payment_method`, so provider-aware webhook guards could not distinguish an
-- Epay callback from a Stripe/Creem/Waffo order once those gateways are ported.
--
-- Existing Rust topups were created only by Stripe paths, so backfill/default to
-- `stripe`. Imported Go rows carry their original provider through the migration
-- CLI when this column exists.

ALTER TABLE topups ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'stripe';

CREATE INDEX IF NOT EXISTS idx_topups_payment_provider_status
  ON topups(payment_provider, status);
