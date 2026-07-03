-- Migration 0014: durable redemption credit idempotency.
--
-- Go serializes redemption use with a process-local user lock plus a database
-- transaction. On Workers, process-local locks are not a correctness boundary,
-- so public redemption uses this D1-only anchor to ensure a code credits quota
-- at most once even if the same request is replayed in the same unix second.

ALTER TABLE redemptions ADD COLUMN credited INTEGER NOT NULL DEFAULT 0;

-- Already-used rows imported from Go have already credited their users.
UPDATE redemptions SET credited = 1 WHERE status = 3;
