-- Audited, generation-fenced recovery for quarantined async task polling.
--
-- Recovery is fail-closed. An immutable event may be inserted only while the
-- referenced row still matches the previewed quarantine generation/revision,
-- has no active poll lease, and remains non-terminal. The AFTER INSERT trigger
-- performs the requeue in the same SQLite transaction as the event insert.

CREATE TABLE task_poll_recovery_events (
  resolution_key TEXT NOT NULL PRIMARY KEY CHECK (
    length(resolution_key) = 64 AND resolution_key NOT GLOB '*[^0-9a-f]*'
  ),
  entity_kind TEXT NOT NULL
    CHECK (entity_kind IN ('task', 'midjourney')),
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  public_task_id TEXT NOT NULL CHECK (
    length(public_task_id) > 0 AND length(public_task_id) <= 256
  ),
  expected_poll_generation INTEGER NOT NULL
    CHECK (expected_poll_generation >= 0),
  expected_poll_write_revision INTEGER NOT NULL
    CHECK (expected_poll_write_revision >= 0),
  expected_quarantined_at INTEGER NOT NULL
    CHECK (expected_quarantined_at > 0),
  expected_hard_timeout_at INTEGER NOT NULL
    CHECK (expected_hard_timeout_at >= 0),
  expected_quarantine_reason TEXT NOT NULL CHECK (
    length(expected_quarantine_reason) > 0
      AND length(expected_quarantine_reason) <= 64
  ),
  action TEXT NOT NULL CHECK (action = 'requeue'),
  reason TEXT NOT NULL CHECK (reason IN (
    'provider_configuration_corrected',
    'provider_incident_resolved',
    'provider_task_verified',
    'operator_retry_approved'
  )),
  evidence_reference TEXT NOT NULL CHECK (
    length(evidence_reference) > 0 AND length(evidence_reference) <= 128
  ),
  evidence_sha256 TEXT NOT NULL CHECK (
    length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  preview_token TEXT NOT NULL CHECK (
    length(preview_token) = 64 AND preview_token NOT GLOB '*[^0-9a-f]*'
  ),
  decision_sha256 TEXT NOT NULL CHECK (
    length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  operator_id INTEGER NOT NULL CHECK (operator_id > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE INDEX idx_task_poll_recovery_events_entity
  ON task_poll_recovery_events(entity_kind, entity_id, created_at DESC);

CREATE UNIQUE INDEX idx_task_poll_recovery_events_revision
  ON task_poll_recovery_events(
    entity_kind, entity_id, expected_poll_write_revision
  );

CREATE INDEX idx_tasks_poll_quarantine_queue
  ON tasks(poll_quarantined_at, id)
  WHERE poll_quarantined_at > 0
    AND status NOT IN ('SUCCESS', 'FAILURE')
    AND upstream_task_id != '';

CREATE INDEX idx_midjourneys_poll_quarantine_queue
  ON midjourneys(poll_quarantined_at, id)
  WHERE poll_quarantined_at > 0
    AND status NOT IN ('SUCCESS', 'FAILURE')
    AND mj_id != '';

CREATE TRIGGER task_poll_recovery_event_update_guard
BEFORE UPDATE ON task_poll_recovery_events
BEGIN
  SELECT RAISE(ABORT, 'task poll recovery events are immutable');
END;

CREATE TRIGGER task_poll_recovery_event_delete_guard
BEFORE DELETE ON task_poll_recovery_events
BEGIN
  SELECT RAISE(ABORT, 'task poll recovery events are immutable');
END;

CREATE TRIGGER task_poll_recovery_task_guard
BEFORE INSERT ON task_poll_recovery_events
WHEN NEW.entity_kind = 'task'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM tasks
    WHERE id = NEW.entity_id
      AND task_id = NEW.public_task_id
      AND status NOT IN ('SUCCESS', 'FAILURE')
      AND upstream_task_id != ''
      AND poll_owner = ''
      AND poll_lease_expires_at = 0
      AND poll_generation = NEW.expected_poll_generation
      AND poll_write_revision = NEW.expected_poll_write_revision
      AND poll_quarantined_at = NEW.expected_quarantined_at
      AND poll_quarantine_reason = NEW.expected_quarantine_reason
      AND (
        NEW.expected_hard_timeout_at = 0 OR (
          submit_time > 0
          AND NEW.expected_hard_timeout_at > NEW.created_at
          AND NEW.expected_hard_timeout_at - submit_time BETWEEN 60 AND 2592000
          AND (NEW.expected_hard_timeout_at - submit_time) % 60 = 0
        )
      )
  ) THEN RAISE(ABORT, 'task poll recovery preview is stale') END;
END;

CREATE TRIGGER task_poll_recovery_midjourney_guard
BEFORE INSERT ON task_poll_recovery_events
WHEN NEW.entity_kind = 'midjourney'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM midjourneys
    WHERE id = NEW.entity_id
      AND mj_id = NEW.public_task_id
      AND status NOT IN ('SUCCESS', 'FAILURE')
      AND mj_id != ''
      AND poll_owner = ''
      AND poll_lease_expires_at = 0
      AND poll_generation = NEW.expected_poll_generation
      AND poll_write_revision = NEW.expected_poll_write_revision
      AND poll_quarantined_at = NEW.expected_quarantined_at
      AND poll_quarantine_reason = NEW.expected_quarantine_reason
      AND NEW.expected_hard_timeout_at > NEW.created_at
      AND NEW.expected_hard_timeout_at = (
        CASE
          WHEN submit_time >= 10000000000 THEN CAST(submit_time / 1000 AS INTEGER)
          ELSE submit_time
        END
      ) + 3600
  ) THEN RAISE(ABORT, 'midjourney poll recovery preview is stale') END;
END;

CREATE TRIGGER task_poll_recovery_task_apply
AFTER INSERT ON task_poll_recovery_events
WHEN NEW.entity_kind = 'task'
BEGIN
  UPDATE tasks
  SET next_poll_at = NEW.created_at,
      poll_consecutive_failures = 0,
      poll_last_error_code = '',
      poll_quarantined_at = 0,
      poll_quarantine_reason = '',
      poll_write_revision = poll_write_revision + 1
  WHERE id = NEW.entity_id
    AND task_id = NEW.public_task_id
    AND poll_generation = NEW.expected_poll_generation
    AND poll_write_revision = NEW.expected_poll_write_revision
    AND poll_quarantined_at = NEW.expected_quarantined_at
    AND poll_quarantine_reason = NEW.expected_quarantine_reason;
END;

CREATE TRIGGER task_poll_recovery_midjourney_apply
AFTER INSERT ON task_poll_recovery_events
WHEN NEW.entity_kind = 'midjourney'
BEGIN
  UPDATE midjourneys
  SET next_poll_at = NEW.created_at,
      poll_consecutive_failures = 0,
      poll_last_error_code = '',
      poll_quarantined_at = 0,
      poll_quarantine_reason = '',
      poll_write_revision = poll_write_revision + 1
  WHERE id = NEW.entity_id
    AND mj_id = NEW.public_task_id
    AND poll_generation = NEW.expected_poll_generation
    AND poll_write_revision = NEW.expected_poll_write_revision
    AND poll_quarantined_at = NEW.expected_quarantined_at
    AND poll_quarantine_reason = NEW.expected_quarantine_reason;
END;
