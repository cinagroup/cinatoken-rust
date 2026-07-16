-- Add a default-off, observer-only R2 inventory for Container artifacts.
-- The inventory reads R2 and authoritative D1 references, writes only its
-- own cursor/finding tables, and deliberately has no delete/apply authority.

CREATE INDEX idx_relay_container_operations_input_object_identity
  ON relay_container_operations(input_object_key, input_object_version);

CREATE INDEX idx_relay_container_operations_result_object_identity
  ON relay_container_operations(result_object_key, result_object_version)
  WHERE result_object_key IS NOT NULL;

CREATE INDEX idx_relay_container_terminal_events_client_response_object_identity
  ON relay_container_terminal_events(
    client_response_object_key,
    client_response_object_version
  )
  WHERE client_response_object_key IS NOT NULL;

CREATE TABLE relay_container_r2_inventory_cursors (
  lane_name TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(lane_name) = 'text'
      AND lane_name IN ('input', 'result', 'client_response')
    ),
  object_prefix TEXT NOT NULL UNIQUE
    CHECK (
      typeof(object_prefix) = 'text'
      AND object_prefix IN (
        'container-inputs/v1/',
        'container-results/v1/',
        'container-client-responses/v1/'
      )
    ),
  r2_cursor TEXT NOT NULL DEFAULT ''
    CHECK (typeof(r2_cursor) = 'text' AND length(r2_cursor) <= 4096),
  round_active INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(round_active) = 'integer' AND round_active IN (0, 1)),
  scan_generation INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(scan_generation) = 'integer'
      AND scan_generation BETWEEN 0 AND 2147483647
    ),
  run_generation INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(run_generation) = 'integer'
      AND run_generation BETWEEN 0 AND 2147483647
    ),
  run_owner TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(run_owner) = 'text'
      AND (
        run_owner = ''
        OR (
          length(run_owner) = 32
          AND run_owner NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  run_lease_expires_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(run_lease_expires_at) = 'integer'
      AND run_lease_expires_at BETWEEN 0 AND 2147483647
    ),
  round_started_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(round_started_at) = 'integer'
      AND round_started_at BETWEEN 0 AND 2147483647
    ),
  round_completed_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(round_completed_at) = 'integer'
      AND round_completed_at BETWEEN 0 AND 2147483647
    ),
  last_started_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(last_started_at) = 'integer'
      AND last_started_at BETWEEN 0 AND 2147483647
    ),
  last_completed_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(last_completed_at) = 'integer'
      AND last_completed_at BETWEEN 0 AND 2147483647
    ),
  last_success_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(last_success_at) = 'integer'
      AND last_success_at BETWEEN 0 AND 2147483647
    ),
  last_error_code TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(last_error_code) = 'text'
      AND length(last_error_code) <= 64
      AND last_error_code NOT GLOB '*[^a-z0-9_:-]*'
    ),
  last_page_scanned INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_page_scanned) = 'integer' AND last_page_scanned >= 0),
  last_page_deferred INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_page_deferred) = 'integer' AND last_page_deferred >= 0),
  last_page_referenced INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_page_referenced) = 'integer' AND last_page_referenced >= 0),
  last_page_anomalies INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_page_anomalies) = 'integer' AND last_page_anomalies >= 0),
  last_page_resolved INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_page_resolved) = 'integer' AND last_page_resolved >= 0),
  total_scanned INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total_scanned) = 'integer' AND total_scanned >= 0),
  total_deferred INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total_deferred) = 'integer' AND total_deferred >= 0),
  total_referenced INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total_referenced) = 'integer' AND total_referenced >= 0),
  total_anomalies INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total_anomalies) = 'integer' AND total_anomalies >= 0),
  total_resolved INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(total_resolved) = 'integer' AND total_resolved >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(updated_at) = 'integer'
      AND updated_at BETWEEN 0 AND 2147483647
    ),
  CHECK (
    (lane_name = 'input' AND object_prefix = 'container-inputs/v1/')
    OR (lane_name = 'result' AND object_prefix = 'container-results/v1/')
    OR (
      lane_name = 'client_response'
      AND object_prefix = 'container-client-responses/v1/'
    )
  ),
  CHECK (
    last_page_scanned =
      last_page_deferred + last_page_referenced + last_page_anomalies
  ),
  CHECK (last_page_resolved <= last_page_referenced),
  CHECK (total_scanned = total_deferred + total_referenced + total_anomalies),
  CHECK (total_resolved <= total_referenced),
  CHECK (round_started_at <= updated_at),
  CHECK (round_completed_at <= updated_at),
  CHECK (last_started_at <= updated_at),
  CHECK (last_completed_at <= updated_at),
  CHECK (last_success_at <= last_completed_at),
  CHECK (
    (
      scan_generation = 0
      AND round_active = 0
      AND r2_cursor = ''
      AND round_started_at = 0
      AND round_completed_at = 0
    )
    OR (
      scan_generation > 0
      AND (
        (
          round_active = 1
          AND round_started_at >= round_completed_at
        )
        OR (
          round_active = 0
          AND r2_cursor = ''
          AND round_started_at > 0
          AND round_completed_at >= round_started_at
        )
      )
    )
  ),
  CHECK (
    (
      run_generation = 0
      AND run_owner = ''
      AND run_lease_expires_at = 0
      AND last_started_at = 0
      AND last_completed_at = 0
      AND last_success_at = 0
      AND last_error_code = ''
    )
    OR (
      run_generation > 0
      AND last_started_at > 0
      AND (
        (
          length(run_owner) = 32
          AND run_lease_expires_at > updated_at
          AND last_completed_at <= last_started_at
          AND last_error_code = ''
        )
        OR (
          run_owner = ''
          AND run_lease_expires_at = 0
          AND last_completed_at >= last_started_at
          AND (
            (last_error_code = '' AND last_success_at = last_completed_at)
            OR length(last_error_code) > 0
          )
        )
      )
    )
  )
);

INSERT INTO relay_container_r2_inventory_cursors (lane_name, object_prefix)
VALUES
  ('input', 'container-inputs/v1/'),
  ('result', 'container-results/v1/'),
  ('client_response', 'container-client-responses/v1/');

CREATE TRIGGER relay_container_r2_inventory_cursor_identity_immutable_guard
BEFORE UPDATE OF lane_name, object_prefix
ON relay_container_r2_inventory_cursors
FOR EACH ROW
WHEN
  NEW.lane_name IS NOT OLD.lane_name
  OR NEW.object_prefix IS NOT OLD.object_prefix
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory cursor identity is immutable');
END;

CREATE TRIGGER relay_container_r2_inventory_cursor_lifecycle_guard
BEFORE UPDATE ON relay_container_r2_inventory_cursors
FOR EACH ROW
WHEN NOT (
  NEW.lane_name IS OLD.lane_name
  AND NEW.object_prefix IS OLD.object_prefix
  AND NEW.updated_at >= OLD.updated_at
  AND (
    (
      NEW.r2_cursor = OLD.r2_cursor
      AND NEW.round_active = OLD.round_active
      AND NEW.scan_generation = OLD.scan_generation
      AND NEW.round_started_at = OLD.round_started_at
      AND NEW.round_completed_at = OLD.round_completed_at
      AND NEW.last_page_scanned = OLD.last_page_scanned
      AND NEW.last_page_deferred = OLD.last_page_deferred
      AND NEW.last_page_referenced = OLD.last_page_referenced
      AND NEW.last_page_anomalies = OLD.last_page_anomalies
      AND NEW.last_page_resolved = OLD.last_page_resolved
      AND NEW.total_scanned = OLD.total_scanned
      AND NEW.total_deferred = OLD.total_deferred
      AND NEW.total_referenced = OLD.total_referenced
      AND NEW.total_anomalies = OLD.total_anomalies
      AND NEW.total_resolved = OLD.total_resolved
      AND NEW.run_generation = OLD.run_generation + 1
      AND length(NEW.run_owner) = 32
      AND NEW.run_lease_expires_at > NEW.updated_at
      AND NEW.last_started_at = NEW.updated_at
      AND NEW.last_started_at >= OLD.last_started_at
      AND NEW.last_completed_at = OLD.last_completed_at
      AND NEW.last_success_at = OLD.last_success_at
      AND NEW.last_error_code = ''
      AND (
        (OLD.run_owner = '' AND OLD.run_lease_expires_at = 0)
        OR (
          length(OLD.run_owner) = 32
          AND OLD.run_lease_expires_at <= NEW.updated_at
        )
      )
    )
    OR (
      NEW.run_generation = OLD.run_generation
      AND NEW.run_owner = OLD.run_owner
      AND NEW.run_lease_expires_at = OLD.run_lease_expires_at
      AND NEW.last_started_at = OLD.last_started_at
      AND NEW.last_completed_at = OLD.last_completed_at
      AND NEW.last_success_at = OLD.last_success_at
      AND NEW.last_error_code = OLD.last_error_code
      AND length(OLD.run_owner) = 32
      AND OLD.run_lease_expires_at > NEW.updated_at
      AND OLD.round_active = 0
      AND OLD.r2_cursor = ''
      AND NEW.round_active = 1
      AND NEW.r2_cursor = ''
      AND NEW.scan_generation = OLD.scan_generation + 1
      AND NEW.round_started_at = NEW.updated_at
      AND NEW.round_completed_at = OLD.round_completed_at
      AND NEW.last_page_scanned = OLD.last_page_scanned
      AND NEW.last_page_deferred = OLD.last_page_deferred
      AND NEW.last_page_referenced = OLD.last_page_referenced
      AND NEW.last_page_anomalies = OLD.last_page_anomalies
      AND NEW.last_page_resolved = OLD.last_page_resolved
      AND NEW.total_scanned = OLD.total_scanned
      AND NEW.total_deferred = OLD.total_deferred
      AND NEW.total_referenced = OLD.total_referenced
      AND NEW.total_anomalies = OLD.total_anomalies
      AND NEW.total_resolved = OLD.total_resolved
    )
    OR (
      NEW.run_generation = OLD.run_generation
      AND NEW.run_owner = OLD.run_owner
      AND NEW.run_lease_expires_at = OLD.run_lease_expires_at
      AND NEW.last_started_at = OLD.last_started_at
      AND NEW.last_completed_at = OLD.last_completed_at
      AND NEW.last_success_at = OLD.last_success_at
      AND NEW.last_error_code = OLD.last_error_code
      AND length(OLD.run_owner) = 32
      AND OLD.run_lease_expires_at > NEW.updated_at
      AND OLD.round_active = 1
      AND NEW.scan_generation = OLD.scan_generation
      AND NEW.round_started_at = OLD.round_started_at
      AND (
        (
          NEW.round_active = 1
          AND length(NEW.r2_cursor) > 0
          AND NEW.r2_cursor <> OLD.r2_cursor
          AND NEW.round_completed_at = OLD.round_completed_at
        )
        OR (
          NEW.round_active = 0
          AND NEW.r2_cursor = ''
          AND NEW.round_completed_at = NEW.updated_at
        )
      )
      AND NEW.total_scanned = OLD.total_scanned + NEW.last_page_scanned
      AND NEW.total_deferred = OLD.total_deferred + NEW.last_page_deferred
      AND NEW.total_referenced = OLD.total_referenced + NEW.last_page_referenced
      AND NEW.total_anomalies = OLD.total_anomalies + NEW.last_page_anomalies
      AND NEW.total_resolved = OLD.total_resolved + NEW.last_page_resolved
    )
    OR (
      NEW.r2_cursor = OLD.r2_cursor
      AND NEW.round_active = OLD.round_active
      AND NEW.scan_generation = OLD.scan_generation
      AND NEW.round_started_at = OLD.round_started_at
      AND NEW.round_completed_at = OLD.round_completed_at
      AND NEW.last_page_scanned = OLD.last_page_scanned
      AND NEW.last_page_deferred = OLD.last_page_deferred
      AND NEW.last_page_referenced = OLD.last_page_referenced
      AND NEW.last_page_anomalies = OLD.last_page_anomalies
      AND NEW.last_page_resolved = OLD.last_page_resolved
      AND NEW.total_scanned = OLD.total_scanned
      AND NEW.total_deferred = OLD.total_deferred
      AND NEW.total_referenced = OLD.total_referenced
      AND NEW.total_anomalies = OLD.total_anomalies
      AND NEW.total_resolved = OLD.total_resolved
      AND length(OLD.run_owner) = 32
      AND OLD.run_lease_expires_at > NEW.updated_at
      AND NEW.run_generation = OLD.run_generation
      AND NEW.run_owner = ''
      AND NEW.run_lease_expires_at = 0
      AND NEW.last_started_at = OLD.last_started_at
      AND NEW.last_completed_at = NEW.updated_at
      AND NEW.last_completed_at >= OLD.last_completed_at
      AND (
        (NEW.last_success_at = NEW.updated_at AND NEW.last_error_code = '')
        OR (
          NEW.last_success_at = OLD.last_success_at
          AND length(NEW.last_error_code) > 0
        )
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory cursor transition is invalid');
END;

CREATE TRIGGER relay_container_r2_inventory_cursor_delete_guard
BEFORE DELETE ON relay_container_r2_inventory_cursors
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory cursor cannot be deleted');
END;

CREATE TABLE relay_container_r2_inventory_findings (
  finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_name TEXT NOT NULL
    CHECK (
      typeof(lane_name) = 'text'
      AND lane_name IN ('input', 'result', 'client_response')
    ),
  object_key TEXT NOT NULL
    CHECK (
      typeof(object_key) = 'text'
      AND length(object_key) BETWEEN 1 AND 1024
    ),
  object_version TEXT NOT NULL
    CHECK (
      typeof(object_version) = 'text'
      AND length(object_version) BETWEEN 1 AND 256
    ),
  operation_id TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(operation_id) = 'text'
      AND (
        operation_id = ''
        OR (
          length(operation_id) BETWEEN 1 AND 128
          AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      )
    ),
  owner_generation INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(owner_generation) = 'integer'
      AND owner_generation BETWEEN 0 AND 2147483647
    ),
  object_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (
      typeof(object_sha256) = 'text'
      AND (
        object_sha256 = ''
        OR (
          length(object_sha256) = 64
          AND object_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      )
    ),
  object_size INTEGER NOT NULL
    CHECK (typeof(object_size) = 'integer' AND object_size >= 0),
  uploaded_at INTEGER NOT NULL
    CHECK (
      typeof(uploaded_at) = 'integer'
      AND uploaded_at BETWEEN 1 AND 2147483647
    ),
  status TEXT NOT NULL DEFAULT 'observed'
    CHECK (
      typeof(status) = 'text'
      AND status IN ('observed', 'candidate', 'resolved')
    ),
  classification TEXT NOT NULL
    CHECK (
      typeof(classification) = 'text'
      AND classification IN (
        'invalid_contract',
        'operation_missing',
        'operation_known_unattached',
        'divergent_reference'
      )
    ),
  first_scan_generation INTEGER NOT NULL
    CHECK (typeof(first_scan_generation) = 'integer' AND first_scan_generation > 0),
  last_scan_generation INTEGER NOT NULL
    CHECK (typeof(last_scan_generation) = 'integer' AND last_scan_generation > 0),
  distinct_scan_generations INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(distinct_scan_generations) = 'integer' AND distinct_scan_generations > 0),
  observation_count INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(observation_count) = 'integer' AND observation_count > 0),
  first_observed_at INTEGER NOT NULL
    CHECK (typeof(first_observed_at) = 'integer' AND first_observed_at > 0),
  last_observed_at INTEGER NOT NULL
    CHECK (typeof(last_observed_at) = 'integer' AND last_observed_at > 0),
  candidate_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(candidate_at) = 'integer' AND candidate_at >= 0),
  resolved_at INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(resolved_at) = 'integer' AND resolved_at >= 0),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer' AND updated_at > 0),
  UNIQUE (object_key, object_version),
  CHECK (first_scan_generation <= last_scan_generation),
  CHECK (distinct_scan_generations <= observation_count),
  CHECK (first_observed_at <= last_observed_at),
  CHECK (last_observed_at <= updated_at),
  CHECK (created_at = first_observed_at),
  CHECK (created_at <= updated_at),
  CHECK (status <> 'candidate' OR classification <> 'divergent_reference'),
  CHECK (
    (
      classification = 'invalid_contract'
      AND operation_id = ''
      AND owner_generation = 0
      AND object_sha256 = ''
    )
    OR (
      classification <> 'invalid_contract'
      AND length(operation_id) > 0
      AND owner_generation > 0
      AND length(object_sha256) = 64
    )
  ),
  CHECK (
    (status = 'observed' AND candidate_at = 0 AND resolved_at = 0)
    OR (
      status = 'candidate'
      AND distinct_scan_generations >= 2
      AND candidate_at BETWEEN first_observed_at AND updated_at
      AND resolved_at = 0
    )
    OR (
      status = 'resolved'
      AND resolved_at = updated_at
      AND candidate_at <= resolved_at
    )
  )
);

CREATE INDEX idx_relay_container_r2_inventory_findings_queue
  ON relay_container_r2_inventory_findings(
    status,
    classification,
    last_observed_at,
    finding_id
  );

CREATE INDEX idx_relay_container_r2_inventory_findings_lane_generation
  ON relay_container_r2_inventory_findings(
    lane_name,
    last_scan_generation,
    status,
    finding_id
  );

CREATE TRIGGER relay_container_r2_inventory_finding_insert_guard
BEFORE INSERT ON relay_container_r2_inventory_findings
FOR EACH ROW
WHEN
  NEW.status <> 'observed'
  OR NEW.first_scan_generation <> NEW.last_scan_generation
  OR NEW.distinct_scan_generations <> 1
  OR NEW.observation_count <> 1
  OR NEW.first_observed_at <> NEW.last_observed_at
  OR NEW.candidate_at <> 0
  OR NEW.resolved_at <> 0
  OR NEW.created_at <> NEW.first_observed_at
  OR NEW.updated_at <> NEW.first_observed_at
  OR NOT EXISTS (
    SELECT 1
    FROM relay_container_r2_inventory_cursors AS cursor
    WHERE cursor.lane_name = NEW.lane_name
      AND cursor.round_active = 1
      AND cursor.scan_generation = NEW.first_scan_generation
      AND length(cursor.run_owner) = 32
      AND cursor.run_lease_expires_at > NEW.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory finding initial state is invalid');
END;

CREATE TRIGGER relay_container_r2_inventory_finding_identity_immutable_guard
BEFORE UPDATE OF finding_id,
                 lane_name,
                 object_key,
                 object_version,
                 operation_id,
                 owner_generation,
                 object_sha256,
                 object_size,
                 uploaded_at,
                 first_scan_generation,
                 first_observed_at,
                 created_at
ON relay_container_r2_inventory_findings
FOR EACH ROW
WHEN
  NEW.finding_id IS NOT OLD.finding_id
  OR NEW.lane_name IS NOT OLD.lane_name
  OR NEW.object_key IS NOT OLD.object_key
  OR NEW.object_version IS NOT OLD.object_version
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.owner_generation IS NOT OLD.owner_generation
  OR NEW.object_sha256 IS NOT OLD.object_sha256
  OR NEW.object_size IS NOT OLD.object_size
  OR NEW.uploaded_at IS NOT OLD.uploaded_at
  OR NEW.first_scan_generation IS NOT OLD.first_scan_generation
  OR NEW.first_observed_at IS NOT OLD.first_observed_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory finding identity is immutable');
END;

CREATE TRIGGER relay_container_r2_inventory_finding_lifecycle_guard
BEFORE UPDATE ON relay_container_r2_inventory_findings
FOR EACH ROW
WHEN NOT (
  NEW.finding_id IS OLD.finding_id
  AND NEW.lane_name IS OLD.lane_name
  AND NEW.object_key IS OLD.object_key
  AND NEW.object_version IS OLD.object_version
  AND NEW.operation_id IS OLD.operation_id
  AND NEW.owner_generation IS OLD.owner_generation
  AND NEW.object_sha256 IS OLD.object_sha256
  AND NEW.object_size IS OLD.object_size
  AND NEW.uploaded_at IS OLD.uploaded_at
  AND NEW.first_scan_generation IS OLD.first_scan_generation
  AND NEW.first_observed_at IS OLD.first_observed_at
  AND NEW.created_at IS OLD.created_at
  AND OLD.status <> 'resolved'
  AND NEW.updated_at >= OLD.updated_at
  AND EXISTS (
    SELECT 1
    FROM relay_container_r2_inventory_cursors AS cursor
    WHERE cursor.lane_name = NEW.lane_name
      AND cursor.round_active = 1
      AND cursor.scan_generation = NEW.last_scan_generation
      AND length(cursor.run_owner) = 32
      AND cursor.run_lease_expires_at > NEW.updated_at
  )
  AND (
    (
      NEW.status = OLD.status
      AND OLD.status IN ('observed', 'candidate')
      AND NEW.last_scan_generation >= OLD.last_scan_generation
      AND NEW.distinct_scan_generations = OLD.distinct_scan_generations +
        CASE WHEN NEW.last_scan_generation > OLD.last_scan_generation THEN 1 ELSE 0 END
      AND NEW.observation_count = OLD.observation_count + 1
      AND NEW.last_observed_at = NEW.updated_at
      AND NEW.last_observed_at >= OLD.last_observed_at
      AND NEW.candidate_at = OLD.candidate_at
      AND NEW.resolved_at = 0
    )
    OR (
      NEW.status = 'resolved'
      AND OLD.status IN ('observed', 'candidate')
      AND NEW.classification = OLD.classification
      AND NEW.last_scan_generation >= OLD.last_scan_generation
      AND NEW.distinct_scan_generations = OLD.distinct_scan_generations +
        CASE WHEN NEW.last_scan_generation > OLD.last_scan_generation THEN 1 ELSE 0 END
      AND NEW.observation_count = OLD.observation_count + 1
      AND NEW.last_observed_at = NEW.updated_at
      AND NEW.last_observed_at >= OLD.last_observed_at
      AND NEW.candidate_at = OLD.candidate_at
      AND NEW.resolved_at = NEW.updated_at
    )
    OR (
      OLD.status = 'candidate'
      AND NEW.status = 'observed'
      AND NEW.classification = 'divergent_reference'
      AND NEW.last_scan_generation >= OLD.last_scan_generation
      AND NEW.distinct_scan_generations = OLD.distinct_scan_generations +
        CASE WHEN NEW.last_scan_generation > OLD.last_scan_generation THEN 1 ELSE 0 END
      AND NEW.observation_count = OLD.observation_count + 1
      AND NEW.last_observed_at = NEW.updated_at
      AND NEW.last_observed_at >= OLD.last_observed_at
      AND NEW.candidate_at = 0
      AND NEW.resolved_at = 0
      AND (
        (
          NEW.lane_name = 'input'
          AND EXISTS (
            SELECT 1 FROM relay_container_operations
            WHERE input_object_key = NEW.object_key
          )
        )
        OR (
          NEW.lane_name = 'result'
          AND EXISTS (
            SELECT 1 FROM relay_container_operations
            WHERE result_object_key = NEW.object_key
          )
        )
        OR (
          NEW.lane_name = 'client_response'
          AND EXISTS (
            SELECT 1 FROM relay_container_terminal_events
            WHERE client_response_object_key = NEW.object_key
          )
        )
      )
    )
    OR (
      OLD.status = 'observed'
      AND NEW.status = 'candidate'
      AND NEW.classification = OLD.classification
      AND NEW.classification <> 'divergent_reference'
      AND NEW.last_scan_generation = OLD.last_scan_generation
      AND NEW.distinct_scan_generations = OLD.distinct_scan_generations
      AND NEW.distinct_scan_generations >= 2
      AND NEW.observation_count = OLD.observation_count
      AND NEW.last_observed_at = OLD.last_observed_at
      AND NEW.candidate_at = NEW.updated_at
      AND NEW.resolved_at = 0
      AND NOT (
        (
          NEW.lane_name = 'input'
          AND EXISTS (
            SELECT 1 FROM relay_container_operations
            WHERE input_object_key = NEW.object_key
          )
        )
        OR (
          NEW.lane_name = 'result'
          AND EXISTS (
            SELECT 1 FROM relay_container_operations
            WHERE result_object_key = NEW.object_key
          )
        )
        OR (
          NEW.lane_name = 'client_response'
          AND EXISTS (
            SELECT 1 FROM relay_container_terminal_events
            WHERE client_response_object_key = NEW.object_key
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM relay_container_operations
        WHERE operation_id = NEW.operation_id
          AND owner_generation = NEW.owner_generation
          AND status IN ('prepared', 'dispatched', 'recovery_required')
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory finding transition is invalid');
END;

CREATE TRIGGER relay_container_r2_inventory_finding_delete_guard
BEFORE DELETE ON relay_container_r2_inventory_findings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container R2 inventory finding cannot be deleted');
END;
