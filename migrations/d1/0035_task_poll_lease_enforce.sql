-- Enforce the generation-fenced task polling writer contract.
--
-- Triggers are installed immediately, but the lifecycle old-writer guard is
-- controlled by task_poll_lease_control.enforcement_enabled and remains off
-- after migration. Production rollout must deploy the 0034-aware Worker,
-- drain legacy cron/DO executions, verify staging races, then set the flag to
-- 1. Provider admission is independently controlled by authority_enabled and
-- also remains off. Rollback disables authority first, then enforcement,
-- before restoring an older Worker.

CREATE TRIGGER task_poll_lease_shape_guard
BEFORE UPDATE OF poll_owner, poll_generation, poll_lease_expires_at,
                 poll_applied_generation ON tasks
WHEN NEW.poll_generation < OLD.poll_generation
  OR NEW.poll_applied_generation < OLD.poll_applied_generation
  OR NEW.poll_applied_generation > NEW.poll_generation
  OR (NEW.poll_lease_expires_at > OLD.poll_lease_expires_at
      AND NEW.poll_generation <= OLD.poll_generation)
  OR (NEW.poll_owner != OLD.poll_owner AND NEW.poll_owner != ''
      AND NEW.poll_generation <= OLD.poll_generation)
  OR (NEW.poll_owner = '' AND NEW.poll_lease_expires_at != 0)
  OR (NEW.poll_owner != '' AND NEW.poll_lease_expires_at <= 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid task poll lease transition');
END;

CREATE TRIGGER midjourney_poll_lease_shape_guard
BEFORE UPDATE OF poll_owner, poll_generation, poll_lease_expires_at,
                 poll_applied_generation ON midjourneys
WHEN NEW.poll_generation < OLD.poll_generation
  OR NEW.poll_applied_generation < OLD.poll_applied_generation
  OR NEW.poll_applied_generation > NEW.poll_generation
  OR (NEW.poll_lease_expires_at > OLD.poll_lease_expires_at
      AND NEW.poll_generation <= OLD.poll_generation)
  OR (NEW.poll_owner != OLD.poll_owner AND NEW.poll_owner != ''
      AND NEW.poll_generation <= OLD.poll_generation)
  OR (NEW.poll_owner = '' AND NEW.poll_lease_expires_at != 0)
  OR (NEW.poll_owner != '' AND NEW.poll_lease_expires_at <= 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid midjourney poll lease transition');
END;

CREATE TRIGGER task_poll_write_revision_guard
BEFORE UPDATE OF status, fail_reason, progress, finish_time ON tasks
WHEN COALESCE((
       SELECT enforcement_enabled
       FROM task_poll_lease_control
       WHERE id = 1
     ), 1) = 1
  AND NEW.poll_write_revision != OLD.poll_write_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'task poll write revision required');
END;

CREATE TRIGGER midjourney_poll_write_revision_guard
BEFORE UPDATE OF status, fail_reason, progress, finish_time ON midjourneys
WHEN COALESCE((
       SELECT enforcement_enabled
       FROM task_poll_lease_control
       WHERE id = 1
     ), 1) = 1
  AND NEW.poll_write_revision != OLD.poll_write_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'midjourney poll write revision required');
END;
