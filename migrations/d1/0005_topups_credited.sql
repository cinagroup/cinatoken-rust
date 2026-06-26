-- Migration 0005: explicit `credited` idempotency anchor for topups.
--
-- The webhook credit (`complete_topup_and_credit`) previously gated the quota
-- credit on `(status = 1 AND complete_time = ?now)`. Two Stripe webhook
-- deliveries for the same trade_no within the SAME unix second both satisfy
-- that guard, so the second delivery double-credits (verified in sqlite). Unix
-- `complete_time` has only second resolution, so it cannot distinguish the
-- first completion from a same-second replay.
--
-- Fix: gate the credit on a dedicated `credited` flag instead of a timestamp.
-- `complete_topup_and_credit` credits while `credited = 0`, then sets
-- `credited = 1` in the same atomic D1 batch (statement order: complete ->
-- credit -> mark). A replay (any timing) finds `credited = 1` and no-ops. This
-- relies only on intra-transaction visibility, not on `changes()` semantics.
--
-- Idempotent: ADD COLUMN is guarded by a one-time apply; re-applying 0005 on a
-- table that already has the column is an error, so apply migrations in order.

ALTER TABLE topups ADD COLUMN credited INTEGER NOT NULL DEFAULT 0;

-- Backfill: any top-up already in status=success (1) was credited under the
-- previous code path. Mark it credited so a late duplicate webhook delivery
-- cannot credit it a second time after this migration lands.
UPDATE topups SET credited = 1 WHERE status = 1;
