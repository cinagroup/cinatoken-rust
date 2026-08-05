CREATE TABLE json_compatibility_deployment_transition_operations (
  operation_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(operation_id_sha256) = 'text'
      AND length(operation_id_sha256) = 64
      AND operation_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  operation_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(operation_digest_sha256) = 'text'
      AND length(operation_digest_sha256) = 64
      AND operation_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  authorized_request_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(authorized_request_sha256) = 'text'
      AND length(authorized_request_sha256) = 64
      AND authorized_request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_plan_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(campaign_plan_digest_sha256) = 'text'
      AND length(campaign_plan_digest_sha256) = 64
      AND campaign_plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  state_plan_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(state_plan_digest_sha256) = 'text'
      AND length(state_plan_digest_sha256) = 64
      AND state_plan_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  transition_id TEXT NOT NULL
    CHECK (
      typeof(transition_id) = 'text'
      AND length(transition_id) BETWEEN 1 AND 128
      AND transition_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  operation_json TEXT NOT NULL
    CHECK (
      typeof(operation_json) = 'text'
      AND length(CAST(operation_json AS BLOB)) BETWEEN 2 AND 8192
    ),
  coordinator_version_id TEXT NOT NULL
    CHECK (
      typeof(coordinator_version_id) = 'text'
      AND length(coordinator_version_id) BETWEEN 1 AND 128
    ),
  coordinator_profile_version INTEGER NOT NULL
    CHECK (
      typeof(coordinator_profile_version) = 'integer'
      AND coordinator_profile_version = 1
    ),
  deployment_leaf_service_name TEXT NOT NULL
    CHECK (
      typeof(deployment_leaf_service_name) = 'text'
      AND length(deployment_leaf_service_name) BETWEEN 1 AND 128
      AND deployment_leaf_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  source_verifier_service_name TEXT NOT NULL
    CHECK (
      typeof(source_verifier_service_name) = 'text'
      AND length(source_verifier_service_name) BETWEEN 1 AND 128
      AND source_verifier_service_name NOT GLOB '*[^a-z0-9-]*'
    ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer')
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_transition_events (
  operation_id_sha256 TEXT NOT NULL,
  event_ordinal INTEGER NOT NULL
    CHECK (typeof(event_ordinal) = 'integer' AND event_ordinal > 0),
  event_kind TEXT NOT NULL
    CHECK (
      event_kind IN (
        'source_authentication',
        'source_readback',
        'mutation_intent',
        'mutation_outcome',
        'target_readback'
      )
    ),
  event_digest_sha256 TEXT NOT NULL
    CHECK (
      typeof(event_digest_sha256) = 'text'
      AND length(event_digest_sha256) = 64
      AND event_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  event_json TEXT NOT NULL
    CHECK (
      typeof(event_json) = 'text'
      AND length(CAST(event_json AS BLOB)) BETWEEN 2 AND 131072
    ),
  recorded_at INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer'),
  PRIMARY KEY (operation_id_sha256, event_ordinal),
  UNIQUE (operation_id_sha256, event_digest_sha256),
  FOREIGN KEY (operation_id_sha256)
    REFERENCES json_compatibility_deployment_transition_operations(
      operation_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE TABLE json_compatibility_deployment_transition_receipts (
  operation_id_sha256 TEXT PRIMARY KEY NOT NULL,
  receipt_digest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      typeof(receipt_digest_sha256) = 'text'
      AND length(receipt_digest_sha256) = 64
      AND receipt_digest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  result TEXT NOT NULL CHECK (result IN ('completed', 'stopped')),
  receipt_json TEXT NOT NULL
    CHECK (
      typeof(receipt_json) = 'text'
      AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 524288
    ),
  archived_at INTEGER NOT NULL CHECK (typeof(archived_at) = 'integer'),
  FOREIGN KEY (operation_id_sha256)
    REFERENCES json_compatibility_deployment_transition_operations(
      operation_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) WITHOUT ROWID;

CREATE INDEX idx_json_compatibility_deployment_transition_events_kind
ON json_compatibility_deployment_transition_events(
  operation_id_sha256,
  event_kind,
  event_ordinal
);

CREATE TRIGGER json_compatibility_deployment_transition_operation_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_operations
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(ABORT, 'transition operation time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_event_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_events
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.recorded_at <> unixepoch()
  THEN RAISE(ABORT, 'transition event time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_event_terminal_guard
BEFORE INSERT ON json_compatibility_deployment_transition_events
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_receipts
  WHERE operation_id_sha256 = NEW.operation_id_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'transition events cannot follow a terminal receipt');
END;

CREATE TRIGGER json_compatibility_deployment_transition_receipt_time_guard
BEFORE INSERT ON json_compatibility_deployment_transition_receipts
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.archived_at <> unixepoch()
  THEN RAISE(ABORT, 'transition receipt time must come from D1') END;
END;

CREATE TRIGGER json_compatibility_deployment_transition_receipt_source_guard
BEFORE INSERT ON json_compatibility_deployment_transition_receipts
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM json_compatibility_deployment_transition_events
  WHERE operation_id_sha256 = NEW.operation_id_sha256
    AND event_kind = 'source_authentication'
)
BEGIN
  SELECT RAISE(ABORT, 'transition receipt requires source authentication');
END;

CREATE TRIGGER json_compatibility_deployment_transition_operation_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_operations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition operations are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_operation_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_operations
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition operations are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_event_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_events
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition events are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_event_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_events
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition events are append-preserved');
END;

CREATE TRIGGER json_compatibility_deployment_transition_receipt_update_guard
BEFORE UPDATE ON json_compatibility_deployment_transition_receipts
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition receipts are immutable');
END;

CREATE TRIGGER json_compatibility_deployment_transition_receipt_delete_guard
BEFORE DELETE ON json_compatibility_deployment_transition_receipts
FOR EACH ROW BEGIN
  SELECT RAISE(ABORT, 'transition receipts are append-preserved');
END;
