-- Freeze raw provider evidence separately from the interpreted client response.
-- Apply only after every pre-0052 Container canary writer is drained. Historical
-- rows remain readable and are never backfilled or rewritten.

CREATE TABLE migration_0052_relay_container_response_artifact_drain_guard (
  active_count INTEGER NOT NULL CHECK (active_count = 0)
);

INSERT INTO migration_0052_relay_container_response_artifact_drain_guard (active_count)
SELECT COUNT(*)
FROM relay_container_operations
WHERE protocol_version = 1
  AND operation_kind = 'chat_completions_canary'
  AND status IN ('prepared', 'dispatched', 'recovery_required');

DROP TABLE migration_0052_relay_container_response_artifact_drain_guard;

-- No default is intentional. A pre-0052 writer omits this column and is
-- rejected before it can create a prepared operation or call the provider.
ALTER TABLE relay_container_operations
  ADD COLUMN response_artifact_contract TEXT
  CHECK (
    response_artifact_contract IS NULL
    OR response_artifact_contract = 'container-response-artifacts-v1'
  );

CREATE TRIGGER relay_container_response_artifact_operation_insert_guard
BEFORE INSERT ON relay_container_operations
FOR EACH ROW
WHEN NEW.protocol_version = 1
  AND NEW.operation_kind = 'chat_completions_canary'
  AND NEW.response_artifact_contract IS NOT 'container-response-artifacts-v1'
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact writer contract is required');
END;

CREATE TRIGGER relay_container_response_artifact_operation_contract_guard
BEFORE UPDATE ON relay_container_operations
FOR EACH ROW
WHEN OLD.protocol_version = 1
  AND OLD.operation_kind = 'chat_completions_canary'
  AND NEW.response_artifact_contract IS NOT OLD.response_artifact_contract
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact writer contract is immutable');
END;

-- These parent keys let child rows bind the complete immutable authority rather
-- than relying on independent single-column references plus application checks.
CREATE UNIQUE INDEX idx_relay_container_atomic_admissions_response_artifact_identity
  ON relay_container_atomic_admissions(
    reservation_key,
    operation_id,
    owner_generation,
    provider_attempt_generation,
    atomic_admission_sha256,
    operation_admission_sha256
  );

CREATE UNIQUE INDEX idx_relay_container_provider_usage_receipts_response_artifact_identity
  ON relay_container_provider_usage_receipts(
    operation_id,
    owner_generation,
    attempt_generation,
    usage_receipt_sha256
  );

CREATE TABLE relay_container_provider_response_evidence (
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  reservation_key TEXT NOT NULL
    CHECK (
      typeof(reservation_key) = 'text'
      AND length(reservation_key) BETWEEN 1 AND 128
      AND reservation_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation = 2),
  attempt_generation INTEGER NOT NULL
    CHECK (typeof(attempt_generation) = 'integer' AND attempt_generation = 1),
  provider_operation_id TEXT NOT NULL
    CHECK (
      typeof(provider_operation_id) = 'text'
      AND length(provider_operation_id) BETWEEN 1 AND 128
      AND provider_operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  atomic_admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(atomic_admission_sha256) = 'text'
      AND length(atomic_admission_sha256) = 64
      AND atomic_admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  admission_sha256 TEXT NOT NULL
    CHECK (
      typeof(admission_sha256) = 'text'
      AND length(admission_sha256) = 64
      AND admission_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      typeof(request_sha256) = 'text'
      AND length(request_sha256) = 64
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  channel_id INTEGER NOT NULL
    CHECK (typeof(channel_id) = 'integer' AND channel_id > 0),
  selected_group TEXT NOT NULL
    CHECK (typeof(selected_group) = 'text' AND length(selected_group) BETWEEN 1 AND 64),
  model_name TEXT NOT NULL
    CHECK (
      typeof(model_name) = 'text'
      AND length(model_name) BETWEEN 1 AND 200
      AND model_name NOT GLOB '*[^A-Za-z0-9._:/-]*'
    ),
  endpoint_path TEXT NOT NULL
    CHECK (
      typeof(endpoint_path) = 'text'
      AND length(endpoint_path) BETWEEN 1 AND 256
      AND endpoint_path NOT GLOB '*[^A-Za-z0-9_./:-]*'
    ),
  egress_profile TEXT NOT NULL
    CHECK (
      typeof(egress_profile) = 'text'
      AND egress_profile = 'openai-chat-completions-canary-v1'
    ),
  egress_worker_version_id TEXT NOT NULL
    CHECK (
      typeof(egress_worker_version_id) = 'text'
      AND length(egress_worker_version_id) BETWEEN 1 AND 128
      AND egress_worker_version_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
    ),
  raw_response_status INTEGER NOT NULL
    CHECK (
      typeof(raw_response_status) = 'integer'
      AND raw_response_status BETWEEN 100 AND 599
    ),
  raw_response_content_type TEXT
    CHECK (
      raw_response_content_type IS NULL
      OR (
        typeof(raw_response_content_type) = 'text'
        AND length(raw_response_content_type) BETWEEN 3 AND 128
        AND raw_response_content_type NOT GLOB '*[^ -~]*'
      )
    ),
  raw_response_headers_json TEXT NOT NULL
    CHECK (
      typeof(raw_response_headers_json) = 'text'
      AND length(raw_response_headers_json) BETWEEN 2 AND 8192
      AND CASE
        WHEN json_valid(raw_response_headers_json) = 1
        THEN json_type(raw_response_headers_json) = 'object'
        ELSE 0
      END
    ),
  raw_response_headers_sha256 TEXT NOT NULL
    CHECK (
      typeof(raw_response_headers_sha256) = 'text'
      AND length(raw_response_headers_sha256) = 64
      AND raw_response_headers_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  raw_response_object_key TEXT NOT NULL
    CHECK (
      typeof(raw_response_object_key) = 'text'
      AND length(raw_response_object_key) BETWEEN 8 AND 512
    ),
  raw_response_object_version TEXT NOT NULL
    CHECK (
      typeof(raw_response_object_version) = 'text'
      AND length(raw_response_object_version) BETWEEN 1 AND 128
      AND raw_response_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  raw_response_sha256 TEXT NOT NULL
    CHECK (
      typeof(raw_response_sha256) = 'text'
      AND length(raw_response_sha256) = 64
      AND raw_response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  raw_response_size INTEGER NOT NULL
    CHECK (
      typeof(raw_response_size) = 'integer'
      AND raw_response_size BETWEEN 0 AND 4194304
    ),
  provider_request_id TEXT
    CHECK (
      provider_request_id IS NULL
      OR (
        typeof(provider_request_id) = 'text'
        AND length(provider_request_id) BETWEEN 1 AND 128
        AND provider_request_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
      )
    ),
  provider_completed_at INTEGER NOT NULL
    CHECK (
      typeof(provider_completed_at) = 'integer'
      AND provider_completed_at BETWEEN 1 AND 253402300799999
    ),
  interpreter_source_commit TEXT NOT NULL
    CHECK (
      typeof(interpreter_source_commit) = 'text'
      AND interpreter_source_commit = '73652508abc5cb09214dde02d51d69d1d1ccc703'
    ),
  response_contract TEXT NOT NULL
    CHECK (
      typeof(response_contract) = 'text'
      AND response_contract = 'go-openai-response-v1'
    ),
  provider_response_evidence_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(provider_response_evidence_sha256) = 'text'
      AND length(provider_response_evidence_sha256) = 64
      AND provider_response_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  recorded_at INTEGER NOT NULL
    CHECK (
      typeof(recorded_at) = 'integer'
      AND recorded_at >= provider_completed_at
      AND recorded_at <= 253402300799999
    ),
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  UNIQUE (provider_operation_id),
  UNIQUE (raw_response_object_key, raw_response_object_version),
  UNIQUE (
    operation_id,
    owner_generation,
    attempt_generation,
    provider_response_evidence_sha256
  ),
  CHECK (operation_id = reservation_key),
  CHECK (
    raw_response_object_key =
      'container-provider-evidence/v1/' || operation_id || '/' ||
      owner_generation || '/' || attempt_generation || '/' || raw_response_sha256
  ),
  FOREIGN KEY (
    reservation_key,
    operation_id,
    owner_generation,
    attempt_generation,
    atomic_admission_sha256,
    admission_sha256
  ) REFERENCES relay_container_atomic_admissions(
    reservation_key,
    operation_id,
    owner_generation,
    provider_attempt_generation,
    atomic_admission_sha256,
    operation_admission_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, owner_generation, attempt_generation)
    REFERENCES relay_container_provider_egress_grants(
      operation_id,
      owner_generation,
      attempt_generation
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- REPLACE may bypass a main-table DELETE trigger. This separate append-only
-- identity survives the implicit delete and makes the AFTER INSERT abort.
CREATE TABLE relay_container_provider_response_evidence_identities (
  operation_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  attempt_generation INTEGER NOT NULL,
  provider_operation_id TEXT NOT NULL,
  provider_response_evidence_sha256 TEXT NOT NULL,
  raw_response_object_key TEXT NOT NULL,
  raw_response_object_version TEXT NOT NULL,
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  UNIQUE (provider_operation_id),
  UNIQUE (provider_response_evidence_sha256),
  UNIQUE (raw_response_object_key, raw_response_object_version),
  FOREIGN KEY (operation_id, owner_generation, attempt_generation)
    REFERENCES relay_container_provider_response_evidence(
      operation_id,
      owner_generation,
      attempt_generation
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER relay_container_provider_response_evidence_identity_insert_guard
BEFORE INSERT ON relay_container_provider_response_evidence_identities
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM relay_container_provider_response_evidence_identities AS identity
  WHERE (identity.operation_id = NEW.operation_id
      AND identity.owner_generation = NEW.owner_generation
      AND identity.attempt_generation = NEW.attempt_generation)
     OR identity.provider_operation_id = NEW.provider_operation_id
     OR identity.provider_response_evidence_sha256 =
          NEW.provider_response_evidence_sha256
     OR (identity.raw_response_object_key = NEW.raw_response_object_key
      AND identity.raw_response_object_version = NEW.raw_response_object_version)
)
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence identity is immutable');
END;

CREATE INDEX idx_relay_container_provider_response_evidence_recorded
  ON relay_container_provider_response_evidence(
    provider_completed_at,
    recorded_at,
    operation_id
  );

CREATE TABLE relay_container_client_response_artifacts (
  operation_id TEXT NOT NULL
    CHECK (
      typeof(operation_id) = 'text'
      AND length(operation_id) BETWEEN 1 AND 128
      AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  owner_generation INTEGER NOT NULL
    CHECK (typeof(owner_generation) = 'integer' AND owner_generation = 2),
  attempt_generation INTEGER NOT NULL
    CHECK (typeof(attempt_generation) = 'integer' AND attempt_generation = 1),
  provider_response_evidence_sha256 TEXT NOT NULL
    CHECK (
      typeof(provider_response_evidence_sha256) = 'text'
      AND length(provider_response_evidence_sha256) = 64
      AND provider_response_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  response_contract TEXT NOT NULL
    CHECK (
      typeof(response_contract) = 'text'
      AND response_contract = 'go-openai-response-v1'
    ),
  response_class TEXT NOT NULL
    CHECK (
      typeof(response_class) = 'text'
      AND response_class IN ('success', 'typed_error', 'http_error', 'invalid_body')
    ),
  client_response_status INTEGER NOT NULL
    CHECK (
      typeof(client_response_status) = 'integer'
      AND client_response_status BETWEEN 100 AND 599
    ),
  client_response_content_type TEXT NOT NULL
    CHECK (
      typeof(client_response_content_type) = 'text'
      AND length(client_response_content_type) BETWEEN 3 AND 128
      AND client_response_content_type NOT GLOB '*[^ -~]*'
    ),
  client_response_headers_json TEXT NOT NULL
    CHECK (
      typeof(client_response_headers_json) = 'text'
      AND length(client_response_headers_json) BETWEEN 2 AND 8192
      AND CASE
        WHEN json_valid(client_response_headers_json) = 1
        THEN json_type(client_response_headers_json) = 'object'
        ELSE 0
      END
    ),
  client_response_headers_sha256 TEXT NOT NULL
    CHECK (
      typeof(client_response_headers_sha256) = 'text'
      AND length(client_response_headers_sha256) = 64
      AND client_response_headers_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  client_response_object_key TEXT NOT NULL
    CHECK (
      typeof(client_response_object_key) = 'text'
      AND length(client_response_object_key) BETWEEN 8 AND 512
    ),
  client_response_object_version TEXT NOT NULL
    CHECK (
      typeof(client_response_object_version) = 'text'
      AND length(client_response_object_version) BETWEEN 1 AND 128
      AND client_response_object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  client_response_sha256 TEXT NOT NULL
    CHECK (
      typeof(client_response_sha256) = 'text'
      AND length(client_response_sha256) = 64
      AND client_response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  client_response_size INTEGER NOT NULL
    CHECK (
      typeof(client_response_size) = 'integer'
      AND client_response_size BETWEEN 2 AND 4194304
    ),
  provider_usage_receipt_sha256 TEXT
    CHECK (
      provider_usage_receipt_sha256 IS NULL
      OR (
        typeof(provider_usage_receipt_sha256) = 'text'
        AND length(provider_usage_receipt_sha256) = 64
        AND provider_usage_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  client_response_artifact_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(client_response_artifact_sha256) = 'text'
      AND length(client_response_artifact_sha256) = 64
      AND client_response_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (
      typeof(created_at) = 'integer'
      AND created_at BETWEEN 1 AND 253402300799999
    ),
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  UNIQUE (provider_response_evidence_sha256),
  UNIQUE (client_response_object_key, client_response_object_version),
  CHECK (
    (response_class = 'success'
      AND client_response_status = 200)
    OR (response_class = 'typed_error'
      AND client_response_status = 200
      AND provider_usage_receipt_sha256 IS NULL)
    OR (response_class = 'http_error'
      AND client_response_status <> 200
      AND provider_usage_receipt_sha256 IS NULL)
    OR (response_class = 'invalid_body'
      AND client_response_status = 500
      AND provider_usage_receipt_sha256 IS NULL)
  ),
  CHECK (
    client_response_object_key =
      'container-client-artifacts/v1/' || operation_id || '/' ||
      owner_generation || '/' || client_response_artifact_sha256
  ),
  FOREIGN KEY (
    operation_id,
    owner_generation,
    attempt_generation,
    provider_response_evidence_sha256
  ) REFERENCES relay_container_provider_response_evidence(
    operation_id,
    owner_generation,
    attempt_generation,
    provider_response_evidence_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    operation_id,
    owner_generation,
    attempt_generation,
    provider_usage_receipt_sha256
  ) REFERENCES relay_container_provider_usage_receipts(
    operation_id,
    owner_generation,
    attempt_generation,
    usage_receipt_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE relay_container_client_response_artifact_identities (
  operation_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  attempt_generation INTEGER NOT NULL,
  provider_response_evidence_sha256 TEXT NOT NULL,
  client_response_artifact_sha256 TEXT NOT NULL,
  client_response_object_key TEXT NOT NULL,
  client_response_object_version TEXT NOT NULL,
  PRIMARY KEY (operation_id, owner_generation, attempt_generation),
  UNIQUE (provider_response_evidence_sha256),
  UNIQUE (client_response_artifact_sha256),
  UNIQUE (client_response_object_key, client_response_object_version),
  FOREIGN KEY (operation_id, owner_generation, attempt_generation)
    REFERENCES relay_container_client_response_artifacts(
      operation_id,
      owner_generation,
      attempt_generation
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER relay_container_client_response_artifact_identity_insert_guard
BEFORE INSERT ON relay_container_client_response_artifact_identities
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM relay_container_client_response_artifact_identities AS identity
  WHERE (identity.operation_id = NEW.operation_id
      AND identity.owner_generation = NEW.owner_generation
      AND identity.attempt_generation = NEW.attempt_generation)
     OR identity.provider_response_evidence_sha256 =
          NEW.provider_response_evidence_sha256
     OR identity.client_response_artifact_sha256 =
          NEW.client_response_artifact_sha256
     OR (identity.client_response_object_key = NEW.client_response_object_key
      AND identity.client_response_object_version = NEW.client_response_object_version)
)
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact identity is immutable');
END;

CREATE INDEX idx_relay_container_client_response_artifacts_created
  ON relay_container_client_response_artifacts(
    response_class,
    created_at,
    operation_id
  );

CREATE TABLE relay_container_response_artifact_inventory_cursors (
  artifact_namespace TEXT NOT NULL
    CHECK (
      typeof(artifact_namespace) = 'text'
      AND artifact_namespace IN ('provider_evidence', 'client_artifact')
    ),
  scan_generation INTEGER NOT NULL
    CHECK (
      typeof(scan_generation) = 'integer'
      AND scan_generation BETWEEN 1 AND 2147483647
    ),
  page_sequence INTEGER NOT NULL
    CHECK (
      typeof(page_sequence) = 'integer'
      AND page_sequence BETWEEN 1 AND 2147483647
    ),
  object_prefix TEXT NOT NULL
    CHECK (
      (artifact_namespace = 'provider_evidence'
        AND object_prefix = 'container-provider-evidence/v1/')
      OR (artifact_namespace = 'client_artifact'
        AND object_prefix = 'container-client-artifacts/v1/')
    ),
  cursor_before TEXT NOT NULL
    CHECK (
      typeof(cursor_before) = 'text'
      AND length(cursor_before) BETWEEN 0 AND 2048
      AND cursor_before NOT GLOB '*[^ -~]*'
    ),
  cursor_after TEXT NOT NULL
    CHECK (
      typeof(cursor_after) = 'text'
      AND length(cursor_after) BETWEEN 0 AND 2048
      AND cursor_after NOT GLOB '*[^ -~]*'
    ),
  checkpoint_status TEXT NOT NULL
    CHECK (
      typeof(checkpoint_status) = 'text'
      AND checkpoint_status IN ('page', 'complete')
    ),
  page_object_count INTEGER NOT NULL
    CHECK (
      typeof(page_object_count) = 'integer'
      AND page_object_count BETWEEN 0 AND 1000
    ),
  observer_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(observer_enabled) = 'integer'
      AND observer_enabled IN (0, 1)
    ),
  observer_mode TEXT NOT NULL DEFAULT 'observe_only'
    CHECK (
      typeof(observer_mode) = 'text'
      AND observer_mode = 'observe_only'
    ),
  apply_authority INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(apply_authority) = 'integer'
      AND apply_authority = 0
    ),
  delete_authority INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(delete_authority) = 'integer'
      AND delete_authority = 0
    ),
  inventory_cursor_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(inventory_cursor_sha256) = 'text'
      AND length(inventory_cursor_sha256) = 64
      AND inventory_cursor_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at INTEGER NOT NULL
    CHECK (
      typeof(created_at) = 'integer'
      AND created_at BETWEEN 1 AND 253402300799999
    ),
  PRIMARY KEY (artifact_namespace, scan_generation, page_sequence),
  UNIQUE (
    artifact_namespace,
    scan_generation,
    page_sequence,
    inventory_cursor_sha256
  ),
  CHECK (
    (checkpoint_status = 'page'
      AND length(cursor_after) BETWEEN 1 AND 2048
      AND cursor_after <> cursor_before)
    OR (checkpoint_status = 'complete' AND cursor_after = '')
  )
);

CREATE TABLE relay_container_response_artifact_inventory_cursor_identities (
  artifact_namespace TEXT NOT NULL,
  scan_generation INTEGER NOT NULL,
  page_sequence INTEGER NOT NULL,
  cursor_before TEXT NOT NULL,
  cursor_after TEXT NOT NULL,
  checkpoint_status TEXT NOT NULL,
  inventory_cursor_sha256 TEXT NOT NULL,
  PRIMARY KEY (artifact_namespace, scan_generation, page_sequence),
  UNIQUE (inventory_cursor_sha256),
  FOREIGN KEY (
    artifact_namespace,
    scan_generation,
    page_sequence,
    inventory_cursor_sha256
  ) REFERENCES relay_container_response_artifact_inventory_cursors(
    artifact_namespace,
    scan_generation,
    page_sequence,
    inventory_cursor_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_identity_insert_guard
BEFORE INSERT ON relay_container_response_artifact_inventory_cursor_identities
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM relay_container_response_artifact_inventory_cursor_identities AS identity
  WHERE (identity.artifact_namespace = NEW.artifact_namespace
      AND identity.scan_generation = NEW.scan_generation
      AND identity.page_sequence = NEW.page_sequence)
     OR identity.inventory_cursor_sha256 = NEW.inventory_cursor_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor identity is immutable');
END;

CREATE INDEX idx_relay_container_response_artifact_inventory_cursors_created
  ON relay_container_response_artifact_inventory_cursors(
    artifact_namespace,
    created_at,
    scan_generation,
    page_sequence
  );

CREATE TABLE relay_container_response_artifact_inventory_findings (
  finding_id TEXT PRIMARY KEY
    CHECK (
      typeof(finding_id) = 'text'
      AND length(finding_id) = 64
      AND finding_id NOT GLOB '*[^0-9a-f]*'
    ),
  artifact_namespace TEXT NOT NULL
    CHECK (
      typeof(artifact_namespace) = 'text'
      AND artifact_namespace IN ('provider_evidence', 'client_artifact')
    ),
  scan_generation INTEGER NOT NULL
    CHECK (
      typeof(scan_generation) = 'integer'
      AND scan_generation BETWEEN 1 AND 2147483647
    ),
  page_sequence INTEGER NOT NULL
    CHECK (
      typeof(page_sequence) = 'integer'
      AND page_sequence BETWEEN 1 AND 2147483647
    ),
  inventory_cursor_sha256 TEXT NOT NULL
    CHECK (
      typeof(inventory_cursor_sha256) = 'text'
      AND length(inventory_cursor_sha256) = 64
      AND inventory_cursor_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  object_key TEXT NOT NULL
    CHECK (
      typeof(object_key) = 'text'
      AND length(object_key) BETWEEN 8 AND 512
      AND object_key NOT GLOB '*[^ -~]*'
      AND (
        (artifact_namespace = 'provider_evidence'
          AND substr(object_key, 1, 31) = 'container-provider-evidence/v1/')
        OR (artifact_namespace = 'client_artifact'
          AND substr(object_key, 1, 30) = 'container-client-artifacts/v1/')
      )
    ),
  object_version TEXT NOT NULL
    CHECK (
      typeof(object_version) = 'text'
      AND length(object_version) BETWEEN 1 AND 128
      AND object_version NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_id TEXT
    CHECK (
      operation_id IS NULL
      OR (
        typeof(operation_id) = 'text'
        AND length(operation_id) BETWEEN 1 AND 128
        AND operation_id NOT GLOB '*[^ -~]*'
      )
    ),
  owner_generation INTEGER
    CHECK (
      owner_generation IS NULL
      OR (
        typeof(owner_generation) = 'integer'
        AND owner_generation BETWEEN 1 AND 2147483647
      )
    ),
  attempt_generation INTEGER
    CHECK (
      attempt_generation IS NULL
      OR (
        typeof(attempt_generation) = 'integer'
        AND attempt_generation = 1
      )
    ),
  key_artifact_sha256 TEXT
    CHECK (
      key_artifact_sha256 IS NULL
      OR (
        typeof(key_artifact_sha256) = 'text'
        AND length(key_artifact_sha256) = 64
        AND key_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  object_sha256 TEXT NOT NULL
    CHECK (
      typeof(object_sha256) = 'text'
      AND length(object_sha256) = 64
      AND object_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  object_size INTEGER NOT NULL
    CHECK (
      typeof(object_size) = 'integer'
      AND object_size BETWEEN 0 AND 5497558138880
    ),
  object_uploaded_at INTEGER NOT NULL
    CHECK (
      typeof(object_uploaded_at) = 'integer'
      AND object_uploaded_at BETWEEN 1 AND 253402300799999
    ),
  provider_response_evidence_sha256 TEXT
    CHECK (
      provider_response_evidence_sha256 IS NULL
      OR (
        typeof(provider_response_evidence_sha256) = 'text'
        AND length(provider_response_evidence_sha256) = 64
        AND provider_response_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  client_response_artifact_sha256 TEXT
    CHECK (
      client_response_artifact_sha256 IS NULL
      OR (
        typeof(client_response_artifact_sha256) = 'text'
        AND length(client_response_artifact_sha256) = 64
        AND client_response_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  classification TEXT NOT NULL
    CHECK (
      typeof(classification) = 'text'
      AND classification IN ('referenced', 'orphan', 'divergent', 'malformed_key')
    ),
  observation_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(observation_sha256) = 'text'
      AND length(observation_sha256) = 64
      AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  observer_mode TEXT NOT NULL DEFAULT 'observe_only'
    CHECK (
      typeof(observer_mode) = 'text'
      AND observer_mode = 'observe_only'
    ),
  apply_authority INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(apply_authority) = 'integer'
      AND apply_authority = 0
    ),
  delete_authority INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(delete_authority) = 'integer'
      AND delete_authority = 0
    ),
  observed_at INTEGER NOT NULL
    CHECK (
      typeof(observed_at) = 'integer'
      AND observed_at BETWEEN 1 AND 253402300799999
      AND observed_at >= object_uploaded_at
    ),
  UNIQUE (
    artifact_namespace,
    scan_generation,
    object_key,
    object_version
  ),
  CHECK (
    (classification = 'malformed_key'
      AND operation_id IS NULL
      AND owner_generation IS NULL
      AND attempt_generation IS NULL
      AND key_artifact_sha256 IS NULL)
    OR (classification <> 'malformed_key'
      AND operation_id IS NOT NULL
      AND owner_generation IS NOT NULL
      AND attempt_generation = 1
      AND key_artifact_sha256 IS NOT NULL)
  ),
  CHECK (
    classification = 'malformed_key'
    OR (
      artifact_namespace = 'provider_evidence'
      AND object_key =
        'container-provider-evidence/v1/' || operation_id || '/' ||
        owner_generation || '/' || attempt_generation || '/' ||
        key_artifact_sha256
    )
    OR (
      artifact_namespace = 'client_artifact'
      AND object_key =
        'container-client-artifacts/v1/' || operation_id || '/' ||
        owner_generation || '/' || key_artifact_sha256
    )
  ),
  CHECK (
    (artifact_namespace = 'provider_evidence'
      AND client_response_artifact_sha256 IS NULL
      AND (
        (classification IN ('referenced', 'divergent')
          AND provider_response_evidence_sha256 IS NOT NULL)
        OR (classification IN ('orphan', 'malformed_key')
          AND provider_response_evidence_sha256 IS NULL)
      ))
    OR (artifact_namespace = 'client_artifact'
      AND provider_response_evidence_sha256 IS NULL
      AND (
        (classification IN ('referenced', 'divergent')
          AND client_response_artifact_sha256 IS NOT NULL)
        OR (classification IN ('orphan', 'malformed_key')
          AND client_response_artifact_sha256 IS NULL)
      ))
  ),
  FOREIGN KEY (
    artifact_namespace,
    scan_generation,
    page_sequence,
    inventory_cursor_sha256
  ) REFERENCES relay_container_response_artifact_inventory_cursors(
    artifact_namespace,
    scan_generation,
    page_sequence,
    inventory_cursor_sha256
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (provider_response_evidence_sha256)
    REFERENCES relay_container_provider_response_evidence(
      provider_response_evidence_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (client_response_artifact_sha256)
    REFERENCES relay_container_client_response_artifacts(
      client_response_artifact_sha256
    ) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE relay_container_response_artifact_inventory_finding_identities (
  finding_id TEXT PRIMARY KEY,
  artifact_namespace TEXT NOT NULL,
  scan_generation INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL UNIQUE,
  UNIQUE (
    artifact_namespace,
    scan_generation,
    object_key,
    object_version
  ),
  FOREIGN KEY (finding_id)
    REFERENCES relay_container_response_artifact_inventory_findings(finding_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_identity_insert_guard
BEFORE INSERT ON relay_container_response_artifact_inventory_finding_identities
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM relay_container_response_artifact_inventory_finding_identities AS identity
  WHERE identity.finding_id = NEW.finding_id
     OR identity.observation_sha256 = NEW.observation_sha256
     OR (identity.artifact_namespace = NEW.artifact_namespace
      AND identity.scan_generation = NEW.scan_generation
      AND identity.object_key = NEW.object_key
      AND identity.object_version = NEW.object_version)
)
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding identity is immutable');
END;

CREATE INDEX idx_relay_container_response_artifact_inventory_findings_observed
  ON relay_container_response_artifact_inventory_findings(
    classification,
    observed_at,
    artifact_namespace,
    finding_id
  );

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_insert_guard
BEFORE INSERT ON relay_container_response_artifact_inventory_cursors
FOR EACH ROW
WHEN
  NEW.observer_enabled <> 1
  OR NEW.observer_mode <> 'observe_only'
  OR NEW.apply_authority <> 0
  OR NEW.delete_authority <> 0
  OR NOT (
    (
      NEW.page_sequence = 1
      AND NEW.cursor_before = ''
      AND NEW.scan_generation = COALESCE(
        (
          SELECT MAX(cursor_row.scan_generation)
          FROM relay_container_response_artifact_inventory_cursors AS cursor_row
          WHERE cursor_row.artifact_namespace = NEW.artifact_namespace
        ),
        0
      ) + 1
      AND (
        NEW.scan_generation = 1
        OR EXISTS (
          SELECT 1
          FROM relay_container_response_artifact_inventory_cursors AS previous
          WHERE previous.artifact_namespace = NEW.artifact_namespace
            AND previous.scan_generation = NEW.scan_generation - 1
            AND previous.checkpoint_status = 'complete'
            AND previous.page_sequence = (
              SELECT MAX(last_page.page_sequence)
              FROM relay_container_response_artifact_inventory_cursors AS last_page
              WHERE last_page.artifact_namespace = NEW.artifact_namespace
                AND last_page.scan_generation = NEW.scan_generation - 1
            )
        )
      )
    )
    OR (
      NEW.page_sequence > 1
      AND NEW.scan_generation = (
        SELECT MAX(cursor_row.scan_generation)
        FROM relay_container_response_artifact_inventory_cursors AS cursor_row
        WHERE cursor_row.artifact_namespace = NEW.artifact_namespace
      )
      AND EXISTS (
        SELECT 1
        FROM relay_container_response_artifact_inventory_cursors AS previous
        WHERE previous.artifact_namespace = NEW.artifact_namespace
          AND previous.scan_generation = NEW.scan_generation
          AND previous.page_sequence = NEW.page_sequence - 1
          AND previous.checkpoint_status = 'page'
          AND previous.cursor_after = NEW.cursor_before
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor authority mismatch');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_identity_guard
AFTER INSERT ON relay_container_response_artifact_inventory_cursors
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM relay_container_response_artifact_inventory_cursor_identities AS identity
    WHERE (identity.artifact_namespace = NEW.artifact_namespace
        AND identity.scan_generation = NEW.scan_generation
        AND identity.page_sequence = NEW.page_sequence)
       OR identity.inventory_cursor_sha256 = NEW.inventory_cursor_sha256
  );
  INSERT INTO relay_container_response_artifact_inventory_cursor_identities (
    artifact_namespace,
    scan_generation,
    page_sequence,
    cursor_before,
    cursor_after,
    checkpoint_status,
    inventory_cursor_sha256
  ) VALUES (
    NEW.artifact_namespace,
    NEW.scan_generation,
    NEW.page_sequence,
    NEW.cursor_before,
    NEW.cursor_after,
    NEW.checkpoint_status,
    NEW.inventory_cursor_sha256
  );
END;

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_identity_update_guard
BEFORE UPDATE ON relay_container_response_artifact_inventory_cursor_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor identity is immutable');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_identity_delete_guard
BEFORE DELETE ON relay_container_response_artifact_inventory_cursor_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor identity cannot be deleted');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_update_guard
BEFORE UPDATE ON relay_container_response_artifact_inventory_cursors
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor is immutable');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_cursor_delete_guard
BEFORE DELETE ON relay_container_response_artifact_inventory_cursors
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory cursor cannot be deleted');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_insert_guard
BEFORE INSERT ON relay_container_response_artifact_inventory_findings
FOR EACH ROW
WHEN
  NEW.observer_mode <> 'observe_only'
  OR NEW.apply_authority <> 0
  OR NEW.delete_authority <> 0
  OR NOT EXISTS (
    SELECT 1
    FROM relay_container_response_artifact_inventory_cursors AS cursor_row
    WHERE cursor_row.artifact_namespace = NEW.artifact_namespace
      AND cursor_row.scan_generation = NEW.scan_generation
      AND cursor_row.page_sequence = NEW.page_sequence
      AND cursor_row.inventory_cursor_sha256 = NEW.inventory_cursor_sha256
      AND cursor_row.observer_enabled = 1
      AND cursor_row.observer_mode = 'observe_only'
      AND cursor_row.apply_authority = 0
      AND cursor_row.delete_authority = 0
      AND cursor_row.created_at <= NEW.observed_at
  )
  OR NOT CASE NEW.classification
    WHEN 'referenced' THEN
      (
        NEW.artifact_namespace = 'provider_evidence'
        AND EXISTS (
          SELECT 1
          FROM relay_container_provider_response_evidence AS evidence
          WHERE evidence.provider_response_evidence_sha256 =
                NEW.provider_response_evidence_sha256
            AND evidence.operation_id = NEW.operation_id
            AND evidence.owner_generation = NEW.owner_generation
            AND evidence.attempt_generation = NEW.attempt_generation
            AND evidence.raw_response_object_key = NEW.object_key
            AND evidence.raw_response_object_version = NEW.object_version
            AND evidence.raw_response_sha256 = NEW.key_artifact_sha256
            AND evidence.raw_response_sha256 = NEW.object_sha256
            AND evidence.raw_response_size = NEW.object_size
        )
      )
      OR (
        NEW.artifact_namespace = 'client_artifact'
        AND EXISTS (
          SELECT 1
          FROM relay_container_client_response_artifacts AS artifact
          WHERE artifact.client_response_artifact_sha256 =
                NEW.client_response_artifact_sha256
            AND artifact.operation_id = NEW.operation_id
            AND artifact.owner_generation = NEW.owner_generation
            AND artifact.attempt_generation = NEW.attempt_generation
            AND artifact.client_response_object_key = NEW.object_key
            AND artifact.client_response_object_version = NEW.object_version
            AND artifact.client_response_artifact_sha256 =
                NEW.key_artifact_sha256
            AND artifact.client_response_sha256 = NEW.object_sha256
            AND artifact.client_response_size = NEW.object_size
        )
      )
    WHEN 'orphan' THEN
      (
        NEW.artifact_namespace = 'provider_evidence'
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_provider_response_evidence AS evidence
          WHERE (evidence.operation_id = NEW.operation_id
              AND evidence.owner_generation = NEW.owner_generation
              AND evidence.attempt_generation = NEW.attempt_generation)
             OR (evidence.raw_response_object_key = NEW.object_key
              AND evidence.raw_response_object_version = NEW.object_version)
        )
      )
      OR (
        NEW.artifact_namespace = 'client_artifact'
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_client_response_artifacts AS artifact
          WHERE (artifact.operation_id = NEW.operation_id
              AND artifact.owner_generation = NEW.owner_generation
              AND artifact.attempt_generation = NEW.attempt_generation)
             OR (artifact.client_response_object_key = NEW.object_key
              AND artifact.client_response_object_version = NEW.object_version)
        )
      )
    WHEN 'divergent' THEN
      (
        NEW.artifact_namespace = 'provider_evidence'
        AND EXISTS (
          SELECT 1
          FROM relay_container_provider_response_evidence AS evidence
          WHERE evidence.provider_response_evidence_sha256 =
                NEW.provider_response_evidence_sha256
            AND evidence.operation_id = NEW.operation_id
            AND evidence.owner_generation = NEW.owner_generation
            AND evidence.attempt_generation = NEW.attempt_generation
            AND NOT (
              evidence.raw_response_object_key = NEW.object_key
              AND evidence.raw_response_object_version = NEW.object_version
              AND evidence.raw_response_sha256 = NEW.key_artifact_sha256
              AND evidence.raw_response_sha256 = NEW.object_sha256
              AND evidence.raw_response_size = NEW.object_size
            )
        )
      )
      OR (
        NEW.artifact_namespace = 'client_artifact'
        AND EXISTS (
          SELECT 1
          FROM relay_container_client_response_artifacts AS artifact
          WHERE artifact.client_response_artifact_sha256 =
                NEW.client_response_artifact_sha256
            AND artifact.operation_id = NEW.operation_id
            AND artifact.owner_generation = NEW.owner_generation
            AND artifact.attempt_generation = NEW.attempt_generation
            AND NOT (
              artifact.client_response_object_key = NEW.object_key
              AND artifact.client_response_object_version = NEW.object_version
              AND artifact.client_response_artifact_sha256 =
                    NEW.key_artifact_sha256
              AND artifact.client_response_sha256 = NEW.object_sha256
              AND artifact.client_response_size = NEW.object_size
            )
        )
      )
    WHEN 'malformed_key' THEN
      (
        NEW.artifact_namespace = 'provider_evidence'
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_provider_response_evidence AS evidence
          WHERE evidence.raw_response_object_key = NEW.object_key
            AND evidence.raw_response_object_version = NEW.object_version
        )
      )
      OR (
        NEW.artifact_namespace = 'client_artifact'
        AND NOT EXISTS (
          SELECT 1
          FROM relay_container_client_response_artifacts AS artifact
          WHERE artifact.client_response_object_key = NEW.object_key
            AND artifact.client_response_object_version = NEW.object_version
        )
      )
    ELSE 0
  END
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding authority mismatch');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_identity_guard
AFTER INSERT ON relay_container_response_artifact_inventory_findings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM relay_container_response_artifact_inventory_finding_identities AS identity
    WHERE identity.finding_id = NEW.finding_id
       OR identity.observation_sha256 = NEW.observation_sha256
       OR (identity.artifact_namespace = NEW.artifact_namespace
        AND identity.scan_generation = NEW.scan_generation
        AND identity.object_key = NEW.object_key
        AND identity.object_version = NEW.object_version)
  );
  INSERT INTO relay_container_response_artifact_inventory_finding_identities (
    finding_id,
    artifact_namespace,
    scan_generation,
    object_key,
    object_version,
    observation_sha256
  ) VALUES (
    NEW.finding_id,
    NEW.artifact_namespace,
    NEW.scan_generation,
    NEW.object_key,
    NEW.object_version,
    NEW.observation_sha256
  );
END;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_identity_update_guard
BEFORE UPDATE ON relay_container_response_artifact_inventory_finding_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding identity is immutable');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_identity_delete_guard
BEFORE DELETE ON relay_container_response_artifact_inventory_finding_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding identity cannot be deleted');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_update_guard
BEFORE UPDATE ON relay_container_response_artifact_inventory_findings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding is immutable');
END;

CREATE TRIGGER relay_container_response_artifact_inventory_finding_delete_guard
BEFORE DELETE ON relay_container_response_artifact_inventory_findings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container response artifact inventory finding cannot be deleted');
END;

CREATE TRIGGER relay_container_provider_response_evidence_insert_authority_guard
BEFORE INSERT ON relay_container_provider_response_evidence
FOR EACH ROW
WHEN
  NOT EXISTS (
    SELECT 1
    FROM relay_container_provider_egress_grants AS grant_row
    JOIN relay_container_atomic_admissions AS admission
      ON admission.reservation_key = grant_row.reservation_key
     AND admission.operation_id = grant_row.operation_id
     AND admission.owner_generation = grant_row.owner_generation
     AND admission.provider_attempt_generation = grant_row.attempt_generation
     AND admission.operation_admission_sha256 = grant_row.admission_sha256
    JOIN relay_container_operations AS operation
      ON operation.operation_id = grant_row.operation_id
     AND operation.reservation_key = grant_row.reservation_key
     AND operation.owner_generation = grant_row.owner_generation
     AND operation.provider_operation_id = grant_row.provider_operation_id
     AND operation.admission_sha256 = grant_row.admission_sha256
     AND operation.input_sha256 = grant_row.request_sha256
    JOIN relay_billing_reservations AS reservation
      ON reservation.reservation_key = grant_row.reservation_key
     AND reservation.owner_generation = grant_row.owner_generation
     AND reservation.channel_id = grant_row.channel_id
     AND reservation.selected_group = grant_row.selected_group
     AND reservation.model_name = grant_row.model_name
     AND reservation.endpoint_path = grant_row.endpoint_path
    WHERE grant_row.operation_id = NEW.operation_id
      AND grant_row.reservation_key = NEW.reservation_key
      AND grant_row.owner_generation = NEW.owner_generation
      AND grant_row.attempt_generation = NEW.attempt_generation
      AND grant_row.provider_operation_id = NEW.provider_operation_id
      AND grant_row.admission_sha256 = NEW.admission_sha256
      AND grant_row.request_sha256 = NEW.request_sha256
      AND grant_row.channel_id = NEW.channel_id
      AND grant_row.selected_group = NEW.selected_group
      AND grant_row.model_name = NEW.model_name
      AND grant_row.endpoint_path = NEW.endpoint_path
      AND grant_row.egress_profile = NEW.egress_profile
      AND grant_row.egress_worker_version_id = NEW.egress_worker_version_id
      AND admission.atomic_admission_sha256 = NEW.atomic_admission_sha256
      AND operation.protocol_version = 1
      AND operation.operation_kind = 'chat_completions_canary'
      AND operation.status = 'dispatched'
      AND reservation.status = 'reserved'
      AND NEW.provider_completed_at >= grant_row.authorized_at * 1000
      AND NEW.provider_completed_at < grant_row.execution_deadline_at * 1000
      AND NEW.recorded_at < grant_row.owner_lease_expires_at * 1000
      AND NEW.recorded_at < grant_row.reservation_owner_deadline_at * 1000
      AND NEW.recorded_at < grant_row.reservation_lease_expires_at * 1000
  )
  OR NOT CASE
    WHEN json_valid(NEW.raw_response_headers_json) = 1
      AND json_type(NEW.raw_response_headers_json) = 'object'
    THEN
      NEW.raw_response_headers_json = json(NEW.raw_response_headers_json)
      AND (SELECT COUNT(*) FROM json_each(NEW.raw_response_headers_json)) BETWEEN 0 AND 6
      AND (SELECT COUNT(DISTINCT header.key)
           FROM json_each(NEW.raw_response_headers_json) AS header) =
          (SELECT COUNT(*) FROM json_each(NEW.raw_response_headers_json))
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.raw_response_headers_json) AS header
        WHERE header.key NOT IN (
          'content-language',
          'content-type',
          'openai-request-id',
          'request-id',
          'retry-after',
          'x-request-id'
        )
          OR header.type <> 'text'
          OR length(CAST(header.value AS TEXT)) NOT BETWEEN 1 AND 1024
          OR CAST(header.value AS TEXT) GLOB '*[^ -~]*'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.raw_response_headers_json) AS left_header
        JOIN json_each(NEW.raw_response_headers_json) AS right_header
          ON left_header.id < right_header.id
         AND left_header.key > right_header.key
      )
      AND (
        (
          json_type(NEW.raw_response_headers_json, '$."content-type"') IS 'text'
          AND json_extract(NEW.raw_response_headers_json, '$."content-type"') IS
                NEW.raw_response_content_type
        )
        OR (
          json_type(NEW.raw_response_headers_json, '$."content-type"') IS NULL
          AND NEW.raw_response_content_type IS NULL
        )
      )
      AND NEW.provider_request_id IS CASE
        WHEN json_type(NEW.raw_response_headers_json, '$."x-request-id"') = 'text'
        THEN json_extract(NEW.raw_response_headers_json, '$."x-request-id"')
        WHEN json_type(NEW.raw_response_headers_json, '$."openai-request-id"') = 'text'
        THEN json_extract(NEW.raw_response_headers_json, '$."openai-request-id"')
        WHEN json_type(NEW.raw_response_headers_json, '$."request-id"') = 'text'
        THEN json_extract(NEW.raw_response_headers_json, '$."request-id"')
        ELSE NULL
      END
    ELSE 0
  END
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence authority mismatch');
END;

CREATE TRIGGER relay_container_provider_response_evidence_identity_guard
AFTER INSERT ON relay_container_provider_response_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM relay_container_provider_response_evidence_identities AS identity
    WHERE (identity.operation_id = NEW.operation_id
        AND identity.owner_generation = NEW.owner_generation
        AND identity.attempt_generation = NEW.attempt_generation)
       OR identity.provider_operation_id = NEW.provider_operation_id
       OR identity.provider_response_evidence_sha256 =
            NEW.provider_response_evidence_sha256
       OR (identity.raw_response_object_key = NEW.raw_response_object_key
        AND identity.raw_response_object_version = NEW.raw_response_object_version)
  );
  INSERT INTO relay_container_provider_response_evidence_identities (
    operation_id,
    owner_generation,
    attempt_generation,
    provider_operation_id,
    provider_response_evidence_sha256,
    raw_response_object_key,
    raw_response_object_version
  ) VALUES (
    NEW.operation_id,
    NEW.owner_generation,
    NEW.attempt_generation,
    NEW.provider_operation_id,
    NEW.provider_response_evidence_sha256,
    NEW.raw_response_object_key,
    NEW.raw_response_object_version
  );
END;

CREATE TRIGGER relay_container_provider_response_evidence_identity_update_guard
BEFORE UPDATE ON relay_container_provider_response_evidence_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence identity is immutable');
END;

CREATE TRIGGER relay_container_provider_response_evidence_identity_delete_guard
BEFORE DELETE ON relay_container_provider_response_evidence_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence identity cannot be deleted');
END;

CREATE TRIGGER relay_container_provider_response_evidence_update_guard
BEFORE UPDATE ON relay_container_provider_response_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence is immutable');
END;

CREATE TRIGGER relay_container_provider_response_evidence_delete_guard
BEFORE DELETE ON relay_container_provider_response_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container provider response evidence cannot be deleted');
END;

CREATE TRIGGER relay_container_client_response_artifact_insert_authority_guard
BEFORE INSERT ON relay_container_client_response_artifacts
FOR EACH ROW
WHEN
  NOT EXISTS (
    SELECT 1
    FROM relay_container_provider_response_evidence AS evidence
    JOIN relay_container_provider_egress_grants AS grant_row
      ON grant_row.operation_id = evidence.operation_id
     AND grant_row.owner_generation = evidence.owner_generation
     AND grant_row.attempt_generation = evidence.attempt_generation
    WHERE evidence.operation_id = NEW.operation_id
      AND evidence.owner_generation = NEW.owner_generation
      AND evidence.attempt_generation = NEW.attempt_generation
      AND evidence.provider_response_evidence_sha256 =
            NEW.provider_response_evidence_sha256
      AND evidence.response_contract = NEW.response_contract
      AND NEW.created_at >= evidence.recorded_at
      AND NEW.created_at < grant_row.owner_lease_expires_at * 1000
      AND NEW.created_at < grant_row.reservation_owner_deadline_at * 1000
      AND NEW.created_at < grant_row.reservation_lease_expires_at * 1000
      AND (
        (NEW.response_class = 'success'
          AND evidence.raw_response_status = 200
          AND NEW.client_response_status = 200
          AND NEW.client_response_content_type = 'application/json')
        OR (NEW.response_class = 'typed_error'
          AND evidence.raw_response_status = 200
          AND NEW.client_response_status = 200
          AND NEW.client_response_content_type = 'application/json')
        OR (NEW.response_class = 'http_error'
          AND evidence.raw_response_status <> 200
          AND NEW.client_response_status = evidence.raw_response_status
          AND NEW.client_response_content_type = 'application/json')
        OR (NEW.response_class = 'invalid_body'
          AND evidence.raw_response_status = 200
          AND NEW.client_response_status = 500
          AND NEW.client_response_content_type = 'application/json')
      )
      AND (
        NEW.provider_usage_receipt_sha256 IS NULL
        OR (
          NEW.response_class = 'success'
          AND EXISTS (
            SELECT 1
            FROM relay_container_provider_usage_receipts AS receipt
            WHERE receipt.operation_id = NEW.operation_id
              AND receipt.owner_generation = NEW.owner_generation
              AND receipt.attempt_generation = NEW.attempt_generation
              AND receipt.provider_operation_id = evidence.provider_operation_id
              AND receipt.admission_sha256 = evidence.admission_sha256
              AND receipt.request_sha256 = evidence.request_sha256
              AND receipt.egress_profile = evidence.egress_profile
              AND receipt.egress_worker_version_id = evidence.egress_worker_version_id
              AND receipt.provider_response_status = evidence.raw_response_status
              AND receipt.provider_response_sha256 = evidence.raw_response_sha256
              AND receipt.provider_request_id IS evidence.provider_request_id
              AND receipt.provider_completed_at = evidence.provider_completed_at
              AND receipt.usage_receipt_sha256 = NEW.provider_usage_receipt_sha256
              AND receipt.persisted_at <= NEW.created_at
          )
        )
      )
  )
  OR NOT CASE
    WHEN json_valid(NEW.client_response_headers_json) = 1
      AND json_type(NEW.client_response_headers_json) = 'object'
    THEN
      NEW.client_response_headers_json = json(NEW.client_response_headers_json)
      AND (SELECT COUNT(*) FROM json_each(NEW.client_response_headers_json)) BETWEEN 2 AND 7
      AND (SELECT COUNT(DISTINCT header.key)
           FROM json_each(NEW.client_response_headers_json) AS header) =
          (SELECT COUNT(*) FROM json_each(NEW.client_response_headers_json))
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.client_response_headers_json) AS header
        WHERE header.key NOT IN (
          'cache-control',
          'content-language',
          'content-type',
          'openai-request-id',
          'request-id',
          'retry-after',
          'x-request-id'
        )
          OR header.type <> 'text'
          OR length(CAST(header.value AS TEXT)) NOT BETWEEN 1 AND 1024
          OR CAST(header.value AS TEXT) GLOB '*[^ -~]*'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.client_response_headers_json) AS left_header
        JOIN json_each(NEW.client_response_headers_json) AS right_header
          ON left_header.id < right_header.id
         AND left_header.key > right_header.key
      )
      AND json_type(NEW.client_response_headers_json, '$."cache-control"') = 'text'
      AND json_extract(NEW.client_response_headers_json, '$."cache-control"') = 'no-store'
      AND json_type(NEW.client_response_headers_json, '$."content-type"') = 'text'
      AND json_extract(NEW.client_response_headers_json, '$."content-type"') =
            NEW.client_response_content_type
      AND (
        (
          NEW.response_class = 'success'
          AND (SELECT COUNT(*) FROM json_each(NEW.client_response_headers_json)) =
                (SELECT COUNT(*)
                 FROM relay_container_provider_response_evidence AS evidence,
                      json_each(evidence.raw_response_headers_json)
                 WHERE evidence.operation_id = NEW.operation_id
                   AND evidence.owner_generation = NEW.owner_generation
                   AND evidence.attempt_generation = NEW.attempt_generation
                   AND json_each.key <> 'content-type') + 2
          AND NOT EXISTS (
            SELECT 1
            FROM relay_container_provider_response_evidence AS evidence,
                 json_each(evidence.raw_response_headers_json) AS raw_header
            WHERE evidence.operation_id = NEW.operation_id
              AND evidence.owner_generation = NEW.owner_generation
              AND evidence.attempt_generation = NEW.attempt_generation
              AND raw_header.key <> 'content-type'
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(NEW.client_response_headers_json) AS client_header
                WHERE client_header.key = raw_header.key
                  AND client_header.value = raw_header.value
                  AND client_header.type = raw_header.type
              )
          )
        )
        OR (
          NEW.response_class IN ('typed_error', 'http_error', 'invalid_body')
          AND NEW.client_response_headers_json =
                '{"cache-control":"no-store","content-type":"application/json"}'
        )
      )
    ELSE 0
  END
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact authority mismatch');
END;

CREATE TRIGGER relay_container_client_response_artifact_identity_guard
AFTER INSERT ON relay_container_client_response_artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact identity is immutable')
  WHERE EXISTS (
    SELECT 1
    FROM relay_container_client_response_artifact_identities AS identity
    WHERE (identity.operation_id = NEW.operation_id
        AND identity.owner_generation = NEW.owner_generation
        AND identity.attempt_generation = NEW.attempt_generation)
       OR identity.provider_response_evidence_sha256 =
            NEW.provider_response_evidence_sha256
       OR identity.client_response_artifact_sha256 =
            NEW.client_response_artifact_sha256
       OR (identity.client_response_object_key = NEW.client_response_object_key
        AND identity.client_response_object_version = NEW.client_response_object_version)
  );
  INSERT INTO relay_container_client_response_artifact_identities (
    operation_id,
    owner_generation,
    attempt_generation,
    provider_response_evidence_sha256,
    client_response_artifact_sha256,
    client_response_object_key,
    client_response_object_version
  ) VALUES (
    NEW.operation_id,
    NEW.owner_generation,
    NEW.attempt_generation,
    NEW.provider_response_evidence_sha256,
    NEW.client_response_artifact_sha256,
    NEW.client_response_object_key,
    NEW.client_response_object_version
  );
END;

CREATE TRIGGER relay_container_client_response_artifact_identity_update_guard
BEFORE UPDATE ON relay_container_client_response_artifact_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact identity is immutable');
END;

CREATE TRIGGER relay_container_client_response_artifact_identity_delete_guard
BEFORE DELETE ON relay_container_client_response_artifact_identities
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact identity cannot be deleted');
END;

CREATE TRIGGER relay_container_client_response_artifact_update_guard
BEFORE UPDATE ON relay_container_client_response_artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact is immutable');
END;

CREATE TRIGGER relay_container_client_response_artifact_delete_guard
BEFORE DELETE ON relay_container_client_response_artifacts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'relay container client response artifact cannot be deleted');
END;

ALTER TABLE relay_container_terminal_events
  ADD COLUMN client_response_artifact_sha256 TEXT
    CHECK (
      client_response_artifact_sha256 IS NULL
      OR (
        typeof(client_response_artifact_sha256) = 'text'
        AND length(client_response_artifact_sha256) = 64
        AND client_response_artifact_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    )
    REFERENCES relay_container_client_response_artifacts(client_response_artifact_sha256)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_relay_container_terminal_events_response_artifact
  ON relay_container_terminal_events(client_response_artifact_sha256)
  WHERE client_response_artifact_sha256 IS NOT NULL;

CREATE TRIGGER relay_container_terminal_event_response_artifact_guard
BEFORE INSERT ON relay_container_terminal_events
FOR EACH ROW
WHEN
  (
    NEW.billing_action IN ('settle', 'refund')
    AND (
      NEW.client_response_artifact_sha256 IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM relay_container_client_response_artifacts AS artifact
        WHERE artifact.operation_id = NEW.operation_id
          AND artifact.owner_generation = NEW.owner_generation
          AND artifact.attempt_generation = CASE
            WHEN NEW.billing_action = 'settle' THEN NEW.provider_attempt_generation
            ELSE 1
          END
          AND artifact.client_response_artifact_sha256 =
                NEW.client_response_artifact_sha256
          AND artifact.client_response_status = NEW.client_response_status
          AND artifact.client_response_headers_json = NEW.client_response_headers_json
          AND artifact.client_response_headers_sha256 =
                NEW.client_response_headers_sha256
          AND artifact.client_response_sha256 = NEW.client_response_sha256
          AND artifact.client_response_size = NEW.client_response_size
          AND artifact.client_response_content_type = NEW.client_response_content_type
          AND artifact.created_at < (NEW.created_at + 1) * 1000
          AND (
            (NEW.billing_action = 'settle'
              AND artifact.response_class = 'success'
              AND artifact.provider_usage_receipt_sha256 =
                    NEW.provider_usage_receipt_sha256)
            OR (NEW.billing_action = 'refund'
              AND artifact.response_class IN ('typed_error', 'http_error', 'invalid_body')
              AND artifact.provider_usage_receipt_sha256 IS NULL)
          )
      )
    )
  )
  OR (
    NEW.billing_action = 'recovery_required'
    AND (
      NEW.client_response_artifact_sha256 IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM relay_container_provider_response_evidence AS evidence
        WHERE evidence.operation_id = NEW.operation_id
          AND evidence.owner_generation = NEW.owner_generation
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container terminal event response artifact mismatch');
END;

CREATE TRIGGER relay_container_operation_response_artifact_terminal_guard
BEFORE UPDATE OF status ON relay_container_operations
FOR EACH ROW
WHEN
  OLD.protocol_version = 1
  AND NEW.status IS NOT OLD.status
  AND NEW.status = 'completed'
  AND EXISTS (
    SELECT 1
    FROM relay_container_provider_egress_grants AS grant_row
    WHERE grant_row.operation_id = OLD.operation_id
      AND grant_row.owner_generation = OLD.owner_generation
  )
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    JOIN relay_container_client_response_artifacts AS artifact
      ON artifact.client_response_artifact_sha256 =
           event.client_response_artifact_sha256
     AND artifact.operation_id = event.operation_id
     AND artifact.owner_generation = event.owner_generation
     AND artifact.attempt_generation = event.provider_attempt_generation
    WHERE event.operation_id = OLD.operation_id
      AND event.reservation_key = OLD.reservation_key
      AND event.owner_generation = OLD.owner_generation
      AND event.operation_from_status = OLD.status
      AND event.operation_status = 'completed'
      AND event.billing_action = 'settle'
      AND artifact.response_class = 'success'
      AND artifact.client_response_status = NEW.response_status
      AND artifact.provider_usage_receipt_sha256 =
            event.provider_usage_receipt_sha256
      AND artifact.client_response_sha256 = event.client_response_sha256
      AND artifact.client_response_size = event.client_response_size
      AND artifact.client_response_content_type = event.client_response_content_type
      AND artifact.created_at < (event.created_at + 1) * 1000
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container completed operation lacks a response artifact');
END;

CREATE TRIGGER relay_container_scheduled_terminalization_response_artifact_guard
BEFORE INSERT ON relay_container_scheduled_terminalizations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM relay_container_terminal_events AS event
  JOIN relay_container_client_response_artifacts AS artifact
    ON artifact.client_response_artifact_sha256 =
         event.client_response_artifact_sha256
   AND artifact.operation_id = event.operation_id
   AND artifact.owner_generation = event.owner_generation
   AND artifact.attempt_generation = event.provider_attempt_generation
  WHERE event.billing_event_id = NEW.billing_event_id
    AND event.operation_id = NEW.operation_id
    AND event.owner_generation = NEW.owner_generation
    AND event.operation_status = 'completed'
    AND event.billing_action = 'settle'
    AND artifact.response_class = 'success'
    AND artifact.provider_usage_receipt_sha256 =
          NEW.provider_usage_receipt_sha256
    AND artifact.client_response_sha256 = NEW.provider_result_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'relay container scheduled terminalization lacks a response artifact');
END;

CREATE TRIGGER relay_container_reconciliation_response_artifact_convergence_guard
BEFORE UPDATE ON relay_container_reconciliation_observations
FOR EACH ROW
WHEN
  OLD.status <> 'converged'
  AND NEW.status = 'converged'
  AND EXISTS (
    SELECT 1
    FROM relay_container_provider_egress_grants AS grant_row
    WHERE grant_row.operation_id = NEW.operation_id
      AND grant_row.owner_generation = NEW.owner_generation
  )
  AND NOT EXISTS (
    SELECT 1
    FROM relay_container_terminal_events AS event
    JOIN relay_container_client_response_artifacts AS artifact
      ON artifact.client_response_artifact_sha256 =
           event.client_response_artifact_sha256
     AND artifact.operation_id = event.operation_id
     AND artifact.owner_generation = event.owner_generation
     AND artifact.attempt_generation = event.provider_attempt_generation
    WHERE event.operation_id = NEW.operation_id
      AND event.reservation_key = NEW.reservation_key
      AND event.owner_generation = NEW.owner_generation
      AND event.reconciliation_id = NEW.reconciliation_id
      AND event.operation_status = 'completed'
      AND event.billing_action = 'settle'
      AND artifact.response_class = 'success'
      AND artifact.provider_usage_receipt_sha256 =
            event.provider_usage_receipt_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'relay container reconciliation convergence lacks a response artifact');
END;
