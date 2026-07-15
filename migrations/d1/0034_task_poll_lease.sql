-- Shared generation-fenced ownership for async task provider polling.
--
-- This is the expand half of the rollout. New Workers may claim a bounded
-- lease before provider I/O and fence every result apply by owner+generation.
-- Migration 0035 installs the old-writer guard, but leaves enforcement
-- disabled until operators have drained legacy cron and Durable Object runs.

ALTER TABLE tasks
  ADD COLUMN poll_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks
  ADD COLUMN poll_generation INTEGER NOT NULL DEFAULT 0
  CHECK (poll_generation >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_lease_expires_at INTEGER NOT NULL DEFAULT 0
  CHECK (poll_lease_expires_at >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_applied_generation INTEGER NOT NULL DEFAULT 0
  CHECK (poll_applied_generation >= 0);
ALTER TABLE tasks
  ADD COLUMN poll_write_revision INTEGER NOT NULL DEFAULT 0
  CHECK (poll_write_revision >= 0);

ALTER TABLE midjourneys
  ADD COLUMN poll_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE midjourneys
  ADD COLUMN poll_generation INTEGER NOT NULL DEFAULT 0
  CHECK (poll_generation >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_lease_expires_at INTEGER NOT NULL DEFAULT 0
  CHECK (poll_lease_expires_at >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_applied_generation INTEGER NOT NULL DEFAULT 0
  CHECK (poll_applied_generation >= 0);
ALTER TABLE midjourneys
  ADD COLUMN poll_write_revision INTEGER NOT NULL DEFAULT 0
  CHECK (poll_write_revision >= 0);

CREATE INDEX idx_tasks_poll_lease_due
  ON tasks(poll_lease_expires_at, id)
  WHERE status NOT IN ('SUCCESS', 'FAILURE') AND upstream_task_id != '';

CREATE INDEX idx_midjourneys_poll_lease_due
  ON midjourneys(poll_lease_expires_at, id)
  WHERE status NOT IN ('SUCCESS', 'FAILURE') AND mj_id != '';

CREATE TABLE task_poll_lease_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK (contract_version = 1),
  authority_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (authority_enabled IN (0, 1)),
  enforcement_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (enforcement_enabled IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
);

INSERT INTO task_poll_lease_control
  (id, contract_version, authority_enabled, enforcement_enabled, updated_at)
VALUES
  (1, 1, 0, 0, 0);
