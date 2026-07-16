-- Tighten lifecycle CAS enforcement without changing the operation schema or
-- rewriting existing rows. The 0040 transition graph remains authoritative.

DROP TRIGGER relay_container_operation_lifecycle_guard;

CREATE TRIGGER relay_container_operation_lifecycle_guard
BEFORE UPDATE ON relay_container_operations
FOR EACH ROW
WHEN
  OLD.status IN ('completed', 'failed') OR
  NEW.updated_at < OLD.updated_at OR
  NOT (
    NEW.status = OLD.status OR
    (OLD.status = 'prepared'
      AND NEW.status IN ('dispatched', 'failed', 'recovery_required')) OR
    (OLD.status = 'dispatched'
      AND NEW.status IN ('completed', 'failed', 'recovery_required')) OR
    (OLD.status = 'recovery_required'
      AND NEW.status IN ('completed', 'failed'))
  ) OR
  (
    NEW.status = OLD.status
    AND (
      NEW.response_status IS NOT OLD.response_status OR
      NEW.response_code IS NOT OLD.response_code OR
      NEW.result_object_key IS NOT OLD.result_object_key OR
      NEW.result_object_version IS NOT OLD.result_object_version OR
      NEW.result_sha256 IS NOT OLD.result_sha256 OR
      NEW.result_size IS NOT OLD.result_size OR
      NEW.result_content_type IS NOT OLD.result_content_type OR
      NEW.updated_at IS NOT OLD.updated_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container operation lifecycle transition is invalid');
END;
